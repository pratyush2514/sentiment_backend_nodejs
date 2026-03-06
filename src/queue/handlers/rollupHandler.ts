import { config } from "../../config.js";
import { THREAD_ROLLUP_LIMIT } from "../../constants.js";
import * as db from "../../db/queries.js";
import { estimateCost } from "../../services/costEstimator.js";
import { createEmbeddingProvider } from "../../services/embeddingProvider.js";
import { sanitizeForExternalUse } from "../../services/privacyFilter.js";
import { channelRollup, threadRollup, backfillSummarize, estimateTokens } from "../../services/summarizer.js";
import { logger } from "../../utils/logger.js";
import type { SummaryRollupJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "summaryRollup" });

export async function handleSummaryRollup(
  jobs: Job<SummaryRollupJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, rollupType, threadTs } = job.data;

    log.info({ jobId: job.id, channelId, rollupType, threadTs }, "Starting summary rollup");

    // Budget check
    const dailyCost = await db.getDailyLLMCost(workspaceId);
    if (dailyCost >= config.LLM_DAILY_BUDGET_USD) {
      log.warn({ dailyCost, budget: config.LLM_DAILY_BUDGET_USD }, "Budget exceeded, skipping rollup");
      return;
    }

    if (rollupType === "channel") {
      await handleChannelRollup(workspaceId, channelId);
    } else if (rollupType === "thread" && threadTs) {
      await handleThreadRollup(workspaceId, channelId, threadTs);
    } else if (rollupType === "backfill") {
      await handleBackfillRollup(workspaceId, channelId);
    }

    log.info({ jobId: job.id, channelId, rollupType }, "Summary rollup complete");
  }
}

async function handleChannelRollup(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  // Find messages since last rollup
  const lastDoc = await db.getLatestContextDocument(workspaceId, channelId, "channel_rollup");
  const sinceTs = lastDoc?.source_ts_end ?? "0";

  const messages = await db.getMessagesSinceTs(workspaceId, channelId, sinceTs, 200);
  if (messages.length === 0) {
    log.info({ channelId }, "No new messages for channel rollup");
    await db.resetRollupState(workspaceId, channelId);
    return;
  }

  // Enrich with display names
  const userIds = [...new Set(messages.map((m) => m.user_id))];
  const profiles = await db.getUserProfiles(workspaceId, userIds);
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));

  const enrichedMessages = messages.map((m) => {
    const profile = profileMap.get(m.user_id);
    const rawText = m.normalized_text ?? m.text;
    const sanitized = sanitizeForExternalUse(rawText);
    return {
      userId: m.user_id,
      displayName: profile?.display_name ?? profile?.real_name ?? null,
      text: sanitized.action === "redacted" ? sanitized.text
        : sanitized.action === "skipped" ? "[message contained sensitive content]"
        : rawText,
      ts: m.ts,
    };
  });

  const channelState = await db.getChannelState(workspaceId, channelId);
  const existingSummary = channelState?.running_summary ?? "";
  const existingDecisions = channelState?.key_decisions_json ?? [];

  const result = await channelRollup(existingSummary, enrichedMessages, existingDecisions);
  if (!result) {
    log.warn({ channelId }, "Channel rollup LLM call failed");
    return; // Don't reset counter — pg-boss retry will re-attempt
  }

  // Embed the summary
  const embeddingProvider = createEmbeddingProvider();
  let embedding: number[] | null = null;
  let embeddingTokens = 0;

  if (embeddingProvider) {
    try {
      const embResult = await embeddingProvider.embed(result.summary);
      embedding = embResult.embedding;
      embeddingTokens = embResult.tokenCount;
    } catch (err) {
      log.warn({ err }, "Embedding failed for channel rollup, storing without embedding");
    }
  }

  // Store context document
  await db.insertContextDocument({
    workspaceId,
    channelId,
    docType: "channel_rollup",
    content: result.summary,
    tokenCount: result.tokenCount,
    embedding,
    sourceTsStart: messages[0].ts,
    sourceTsEnd: messages[messages.length - 1].ts,
    sourceThreadTs: null,
    messageCount: messages.length,
  });

  // Update channel state
  await db.upsertChannelState(workspaceId, channelId, {
    running_summary: result.summary,
    key_decisions_json: result.keyDecisions,
  });

  // Reset rollup counter
  await db.resetRollupState(workspaceId, channelId);

  // Record LLM cost
  await recordRollupCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);

  // Record embedding cost
  if (embeddingTokens > 0) {
    await recordRollupCost(workspaceId, channelId, config.EMBEDDING_MODEL, embeddingTokens, 0);
  }

  log.info({
    channelId,
    messagesProcessed: messages.length,
    summaryTokens: result.tokenCount,
    decisions: result.keyDecisions.length,
  }, "Channel rollup stored");
}

async function handleThreadRollup(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const messages = await db.getMessagesEnriched(workspaceId, channelId, {
    limit: THREAD_ROLLUP_LIMIT,
    threadTs,
  });

  if (messages.length === 0) {
    log.info({ channelId, threadTs }, "No messages for thread rollup");
    return;
  }

  const channelState = await db.getChannelState(workspaceId, channelId);
  const channelSummary = channelState?.running_summary ?? "";

  const enrichedMessages = messages.map((m) => {
    const rawText = m.normalized_text ?? m.text;
    const sanitized = sanitizeForExternalUse(rawText);
    return {
      userId: m.user_id,
      displayName: m.display_name ?? m.real_name ?? null,
      text: sanitized.action === "redacted" ? sanitized.text
        : sanitized.action === "skipped" ? "[message contained sensitive content]"
        : rawText,
      ts: m.ts,
    };
  });

  const result = await threadRollup(threadTs, enrichedMessages, channelSummary);
  if (!result) {
    log.warn({ channelId, threadTs }, "Thread rollup LLM call failed");
    return;
  }

  // Embed the summary
  const embeddingProvider = createEmbeddingProvider();
  let embedding: number[] | null = null;
  let embeddingTokens = 0;

  if (embeddingProvider) {
    try {
      const embResult = await embeddingProvider.embed(result.summary);
      embedding = embResult.embedding;
      embeddingTokens = embResult.tokenCount;
    } catch (err) {
      log.warn({ err }, "Embedding failed for thread rollup");
    }
  }

  await db.insertContextDocument({
    workspaceId,
    channelId,
    docType: "thread_rollup",
    content: result.summary,
    tokenCount: result.tokenCount,
    embedding,
    sourceTsStart: messages[0].ts,
    sourceTsEnd: messages[messages.length - 1].ts,
    sourceThreadTs: threadTs,
    messageCount: messages.length,
  });

  // Record costs
  await recordRollupCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
  if (embeddingTokens > 0) {
    await recordRollupCost(workspaceId, channelId, config.EMBEDDING_MODEL, embeddingTokens, 0);
  }

  log.info({ channelId, threadTs, messagesProcessed: messages.length }, "Thread rollup stored");
}

async function handleBackfillRollup(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const result = await backfillSummarize(workspaceId, channelId);
  if (!result) {
    log.info({ channelId }, "Backfill summarization returned no result");
    return;
  }

  // Embed the final summary
  const embeddingProvider = createEmbeddingProvider();
  let embedding: number[] | null = null;

  if (embeddingProvider) {
    try {
      const embResult = await embeddingProvider.embed(result.summary);
      embedding = embResult.embedding;
    } catch (err) {
      log.warn({ err }, "Embedding failed for backfill rollup");
    }
  }

  // Store as context document
  await db.insertContextDocument({
    workspaceId,
    channelId,
    docType: "backfill_rollup",
    content: result.summary,
    tokenCount: estimateTokens(result.summary),
    embedding,
    sourceTsStart: null,
    sourceTsEnd: null,
    sourceThreadTs: null,
    messageCount: 0,
  });

  // Update channel state with LLM-generated summary
  await db.upsertChannelState(workspaceId, channelId, {
    running_summary: result.summary,
    key_decisions_json: result.keyDecisions,
  });

  log.info({ channelId, decisions: result.keyDecisions.length }, "Backfill rollup complete");
}

async function recordRollupCost(
  workspaceId: string,
  channelId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  const cost = estimateCost(model, promptTokens, completionTokens);
  await db.insertLLMCost({
    workspaceId,
    channelId,
    llmProvider: model.startsWith("gemini") ? "gemini" : "openai",
    llmModel: model,
    promptTokens,
    completionTokens,
    estimatedCostUsd: cost,
    jobType: "summary.rollup",
  });
}
