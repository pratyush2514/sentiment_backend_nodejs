import { config } from "../../config.js";
import { THREAD_ROLLUP_LIMIT } from "../../constants.js";
import * as db from "../../db/queries.js";
import { getAnalysisWindowStartTs, isTsWithinAnalysisWindow } from "../../services/analysisWindow.js";
import { materializeBackfillSummary } from "../../services/backfillSummary.js";
import {
  persistCanonicalChannelState,
  resolveCanonicalChannelState,
} from "../../services/canonicalChannelState.js";
import { estimateCost } from "../../services/costEstimator.js";
import { createEmbeddingProvider } from "../../services/embeddingProvider.js";
import { eventBus } from "../../services/eventBus.js";
import {
  insertContextDocumentWithArtifact,
  recordIntelligenceDegradation,
  recordSummaryArtifact,
} from "../../services/intelligenceTruth.js";
import { sanitizeForExternalUse } from "../../services/privacyFilter.js";
import { channelRollup, threadRollup } from "../../services/summarizer.js";
import { getProductWindowStartTs } from "../../services/windowPolicy.js";
import { logger } from "../../utils/logger.js";
import type { SummaryRollupJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

function isSummaryStale(
  summaryCoverageStartTs: string | null,
  windowStartTs: string,
  earliestWindowMessageTs: string | null,
): boolean {
  if (!summaryCoverageStartTs) return true;

  const coverageStartTs = Number.parseFloat(summaryCoverageStartTs);
  const minWindowTs = Number.parseFloat(windowStartTs);
  if (
    !Number.isFinite(coverageStartTs) ||
    coverageStartTs < minWindowTs
  ) {
    return true;
  }

  if (!earliestWindowMessageTs) {
    return false;
  }

  const earliestTs = Number.parseFloat(earliestWindowMessageTs);
  if (!Number.isFinite(earliestTs)) {
    return true;
  }

  return coverageStartTs > earliestTs;
}

function pickCanonicalSummaryBaseDoc(
  channelRollupDoc: Awaited<ReturnType<typeof db.getLatestContextDocument>>,
  backfillRollupDoc: Awaited<ReturnType<typeof db.getLatestContextDocument>>,
) {
  return backfillRollupDoc ?? channelRollupDoc;
}

function maxTs(values: Array<string | null | undefined>): string | null {
  const numeric = values
    .map((value) => Number.parseFloat(value ?? ""))
    .filter((value) => Number.isFinite(value));

  if (numeric.length === 0) {
    return null;
  }

  return String(Math.max(...numeric));
}

function buildLiveThreadHighlightMessages(
  threads: Array<{ thread_ts: string; last_activity: string }>,
  threadInsights: Awaited<ReturnType<typeof db.getThreadInsightsBatch>>,
): Array<{
  userId: string;
  displayName: string;
  text: string;
  ts: string;
  threadTs: string;
}> {
  const insightMap = new Map(
    threadInsights.map((insight) => [insight.thread_ts, insight]),
  );

  return threads.flatMap((thread) => {
    const insight = insightMap.get(thread.thread_ts);
    if (!insight?.summary) {
      return [];
    }

    const ts =
      insight.last_meaningful_change_ts ??
      insight.source_ts_end ??
      thread.thread_ts;
    const sanitized = sanitizeForExternalUse(insight.summary);
    const text =
      sanitized.action === "redacted"
        ? sanitized.text
        : sanitized.action === "skipped"
          ? "[thread update contained sensitive content]"
          : insight.summary;

    const descriptors = [
      `Thread update: ${text}`,
      insight.primary_issue ? `Primary issue: ${insight.primary_issue}` : null,
      insight.thread_state ? `State: ${insight.thread_state}` : null,
      insight.operational_risk !== "none"
        ? `Risk: ${insight.operational_risk}`
        : null,
    ].filter(Boolean);

    return [{
      userId: "thread-insight",
      displayName: "PulseBoard thread insight",
      text: descriptors.join(". "),
      ts,
      threadTs: thread.thread_ts,
    }];
  });
}

const log = logger.child({ handler: "summaryRollup" });

export async function handleSummaryRollup(
  jobs: Job<SummaryRollupJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, rollupType, threadTs, requestedBy } = job.data;

    log.info(
      { jobId: job.id, channelId, rollupType, threadTs, requestedBy: requestedBy ?? "manual" },
      "Starting summary rollup",
    );

    // Budget check
    const dailyCost = await db.getDailyLLMCost(workspaceId);
    if (dailyCost >= config.LLM_DAILY_BUDGET_USD) {
      log.warn({ dailyCost, budget: config.LLM_DAILY_BUDGET_USD }, "Budget exceeded, skipping rollup");
      continue;
    }

    if (rollupType === "channel") {
      await handleChannelRollup(workspaceId, channelId);
    } else if (rollupType === "thread" && threadTs) {
      await handleThreadRollup(workspaceId, channelId, threadTs);
    } else if (rollupType === "backfill") {
      const analysisWindowDays = await db.getEffectiveAnalysisWindowDays(workspaceId, channelId);
      await handleBackfillRollup(workspaceId, channelId, analysisWindowDays);
    }

    log.info(
      { jobId: job.id, channelId, rollupType, threadTs, requestedBy: requestedBy ?? "manual" },
      "Summary rollup complete",
    );
  }
}

async function handleChannelRollup(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const analysisWindowDays = await db.getEffectiveAnalysisWindowDays(workspaceId, channelId);
  const windowStartTs = getAnalysisWindowStartTs(analysisWindowDays);
  const liveWindowStartTs = getProductWindowStartTs("live") ?? windowStartTs;
  // Find messages since last rollup
  const [channelState, lastChannelDoc, lastBackfillDoc, earliestWindowMessages] = await Promise.all([
    db.getChannelState(workspaceId, channelId),
    db.getLatestContextDocument(workspaceId, channelId, "channel_rollup"),
    db.getLatestContextDocument(workspaceId, channelId, "backfill_rollup"),
    db.getMessagesInWindow(workspaceId, channelId, analysisWindowDays, null, 1),
  ]);
  const baseDoc = pickCanonicalSummaryBaseDoc(lastChannelDoc, lastBackfillDoc);
  const summaryCoverageStartTs = baseDoc?.source_ts_start ?? null;
  const earliestWindowMessageTs = earliestWindowMessages[0]?.ts ?? null;
  const activeSummaryEndTs =
    baseDoc?.source_ts_end &&
    Number.parseFloat(baseDoc.source_ts_end) > Number.parseFloat(windowStartTs)
      ? baseDoc.source_ts_end
      : windowStartTs;
  const sinceTs =
    maxTs([
      liveWindowStartTs,
      activeSummaryEndTs,
      channelState?.live_summary_source_ts_end ?? null,
    ]) ?? liveWindowStartTs;

  // Staleness check: if the saved summary either reaches outside the window
  // or fails to cover the earliest message inside the current window, rebuild it.
  const stale = isSummaryStale(
    summaryCoverageStartTs,
    windowStartTs,
    earliestWindowMessageTs,
  );
  if (stale) {
    log.info(
      { channelId, sinceTs, windowStartTs },
      "Summary is stale — regenerating from recent window",
    );
    await handleBackfillRollup(workspaceId, channelId, analysisWindowDays);
    return;
  }

  const [messages, recentThreads] = await Promise.all([
    db.getMessagesSinceTs(workspaceId, channelId, sinceTs, 200),
    db.getActiveThreadsSinceTs(workspaceId, channelId, sinceTs, 12),
  ]);
  const threadInsights = recentThreads.length > 0
    ? await db.getThreadInsightsBatch(
      workspaceId,
      channelId,
      recentThreads.map((thread) => thread.thread_ts),
    )
    : [];

  if (messages.length === 0 && threadInsights.length === 0) {
    log.debug({ channelId }, "No new messages for channel rollup");
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
      threadTs: m.thread_ts,
    };
  });
  const threadHighlightMessages = buildLiveThreadHighlightMessages(
    recentThreads,
    threadInsights,
  );
  const combinedMessages = [...enrichedMessages, ...threadHighlightMessages]
    .sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
  if (combinedMessages.length === 0) {
    log.debug({ channelId }, "No evidence-backed live rollup inputs after enrichment");
    await db.resetRollupState(workspaceId, channelId);
    return;
  }

  const existingSummary = channelState?.live_summary ?? "";
  const canonicalState = await resolveCanonicalChannelState(workspaceId, channelId, {
    channelState,
  });
  const relatedIncidents = await db.getRelatedIncidentMentions(
    workspaceId,
    channelId,
    canonicalState.riskState.healthCounts.analysisWindowDays,
    5,
  );

  const result = await channelRollup(
    existingSummary,
    combinedMessages,
    [],
    {
      effectiveChannelMode: canonicalState.channelMode.effectiveChannelMode,
      signal: canonicalState.riskState.signal,
      health: canonicalState.riskState.health,
      riskDrivers: canonicalState.riskState.riskDrivers,
      attentionSummary: canonicalState.riskState.attentionSummary,
      messageDispositionCounts: canonicalState.riskState.messageDispositionCounts,
      relatedIncidents: relatedIncidents.map((incident) => ({
        sourceChannelName: incident.source_channel_name ?? "unknown",
        message: incident.message_text,
        detectedAt: incident.detected_at,
        blocksLocalWork: incident.blocks_local_work,
      })),
    },
    {
      summaryStyle: "live",
    },
  );
  if (!result) {
    log.warn({ channelId }, "Channel rollup LLM call failed");
    throw new Error(`Channel rollup failed for ${channelId}`);
  }
  if (!result.summary.trim()) {
    log.debug({ channelId }, "No strongly supported live summary facts survived the rollup");
    await db.resetRollupState(workspaceId, channelId);
    return;
  }

  const liveCoverageStartTs = combinedMessages[0]?.ts ?? sinceTs;
  const liveCoverageEndTs = combinedMessages[combinedMessages.length - 1]?.ts ?? sinceTs;

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
      await recordIntelligenceDegradation({
        workspaceId,
        channelId,
        scope: "summary",
        eventType: "embedding_failed",
        severity: "medium",
        details: {
          summaryKind: "channel_rollup",
        },
      });
    }
  }

  const artifact = await recordSummaryArtifact({
    workspaceId,
    channelId,
    kind: "channel_rollup",
    generationMode: "llm",
    completenessStatus: "complete",
    content: result.summary,
    keyDecisions: result.keyDecisions,
    summaryFacts: result.summaryFacts,
    coverageStartTs: liveCoverageStartTs,
    coverageEndTs: liveCoverageEndTs,
    candidateMessageCount: combinedMessages.length,
    includedMessageCount: combinedMessages.length,
    degradedReasons: embedding === null ? ["embedding_failed"] : [],
    updateChannelTruth: false,
  });

  // Store context document
  await insertContextDocumentWithArtifact({
    workspaceId,
    channelId,
    docType: "channel_rollup",
    content: result.summary,
    tokenCount: result.tokenCount,
    embedding,
    sourceTsStart: liveCoverageStartTs,
    sourceTsEnd: liveCoverageEndTs,
    sourceThreadTs: null,
    messageCount: combinedMessages.length,
    summaryArtifactId: artifact.summaryArtifactId,
  });

  // Update channel state
  await db.upsertChannelState(workspaceId, channelId, {
    live_summary: result.summary,
    live_summary_updated_at: new Date(),
    live_summary_source_ts_start: liveCoverageStartTs,
    live_summary_source_ts_end: liveCoverageEndTs,
  });
  await persistCanonicalChannelState(workspaceId, channelId, {
    channel: canonicalState.channel,
    rule: canonicalState.rule,
  });

  // Reset rollup counter
  await db.resetRollupState(workspaceId, channelId);

  // Record LLM cost
  await recordRollupCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);

  // Record embedding cost
  if (embeddingTokens > 0) {
    await recordRollupCost(workspaceId, channelId, config.EMBEDDING_MODEL, embeddingTokens, 0);
  }

  eventBus.createAndPublish("rollup_updated", workspaceId, channelId, {
    rollupType: "channel",
    messagesProcessed: combinedMessages.length,
  });

  log.info({
    channelId,
    messagesProcessed: combinedMessages.length,
    summaryTokens: result.tokenCount,
    decisions: result.keyDecisions.length,
  }, "Channel rollup stored");
}

async function handleThreadRollup(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const analysisWindowDays = await db.getEffectiveAnalysisWindowDays(workspaceId, channelId);
  const windowStartTs = getAnalysisWindowStartTs(analysisWindowDays);
  const [threadMessages, channelState, lastChannelDoc, lastBackfillDoc, earliestWindowMessages] = await Promise.all([
    db.getMessagesEnriched(workspaceId, channelId, {
      limit: THREAD_ROLLUP_LIMIT,
      threadTs,
    }),
    db.getChannelState(workspaceId, channelId),
    db.getLatestContextDocument(workspaceId, channelId, "channel_rollup"),
    db.getLatestContextDocument(workspaceId, channelId, "backfill_rollup"),
    db.getMessagesInWindow(workspaceId, channelId, analysisWindowDays, null, 1),
  ]);
  const messages = threadMessages.filter((message) =>
    isTsWithinAnalysisWindow(message.ts, analysisWindowDays),
  );

  if (messages.length === 0) {
    log.debug({ channelId, threadTs }, "No messages for thread rollup");
    return;
  }

  const baseSummaryDoc = pickCanonicalSummaryBaseDoc(lastChannelDoc, lastBackfillDoc);
  const channelSummary = isSummaryStale(
    baseSummaryDoc?.source_ts_start ?? null,
    windowStartTs,
    earliestWindowMessages[0]?.ts ?? null,
  )
    ? ""
    : channelState?.running_summary ?? "";

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
      threadTs: m.thread_ts,
    };
  });

  const result = await threadRollup(threadTs, enrichedMessages, channelSummary);
  if (!result) {
    log.warn({ channelId, threadTs }, "Thread rollup LLM call failed");
    throw new Error(`Thread rollup failed for ${channelId}:${threadTs}`);
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
      await recordIntelligenceDegradation({
        workspaceId,
        channelId,
        scope: "summary",
        eventType: "embedding_failed",
        severity: "medium",
        threadTs,
        details: {
          summaryKind: "thread_rollup",
        },
      });
    }
  }

  const threadRollupContent = JSON.stringify({
    summary: result.summary,
    openQuestions: result.openQuestions ?? [],
  });

  const artifact = await recordSummaryArtifact({
    workspaceId,
    channelId,
    kind: "thread_rollup",
    generationMode: "llm",
    completenessStatus: "complete",
    content: result.summary,
    keyDecisions: result.keyDecisions,
    summaryFacts: result.summaryFacts,
    coverageStartTs: messages[0].ts,
    coverageEndTs: messages[messages.length - 1].ts,
    candidateMessageCount: messages.length,
    includedMessageCount: messages.length,
    degradedReasons: embedding === null ? ["embedding_failed"] : [],
    updateChannelTruth: false,
  });

  await insertContextDocumentWithArtifact({
    workspaceId,
    channelId,
    docType: "thread_rollup",
    content: threadRollupContent,
    tokenCount: result.tokenCount,
    embedding,
    sourceTsStart: messages[0].ts,
    sourceTsEnd: messages[messages.length - 1].ts,
    sourceThreadTs: threadTs,
    messageCount: messages.length,
    summaryArtifactId: artifact.summaryArtifactId,
  });

  await db.upsertThreadInsight({
    workspaceId,
    channelId,
    threadTs,
    summary: result.summary,
    primaryIssue: result.primaryIssue,
    threadState: result.threadState,
    emotionalTemperature: result.emotionalTemperature,
    operationalRisk: result.operationalRisk,
    surfacePriority: result.surfacePriority,
    crucialMoments: result.crucialMoments,
    openQuestions: result.openQuestions ?? [],
    lastMeaningfulChangeTs:
      result.crucialMoments[result.crucialMoments.length - 1]?.messageTs ??
      messages[messages.length - 1]?.ts ??
      null,
    sourceTsEnd: messages[messages.length - 1]?.ts ?? null,
    rawLlmResponse: {
      summary: result.summary,
      primary_issue: result.primaryIssue,
      thread_state: result.threadState,
      emotional_temperature: result.emotionalTemperature,
      operational_risk: result.operationalRisk,
      surface_priority: result.surfacePriority,
      crucial_moments: result.crucialMoments,
      open_questions: result.openQuestions ?? [],
    },
    llmProvider: config.LLM_PROVIDER,
    llmModel: result.raw.model,
    tokenUsage: {
      promptTokens: result.raw.promptTokens,
      completionTokens: result.raw.completionTokens,
    },
  });
  await persistCanonicalChannelState(workspaceId, channelId);

  // Record costs
  await recordRollupCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
  if (embeddingTokens > 0) {
    await recordRollupCost(workspaceId, channelId, config.EMBEDDING_MODEL, embeddingTokens, 0);
  }

  eventBus.createAndPublish("rollup_updated", workspaceId, channelId, {
    rollupType: "thread",
    threadTs,
    messagesProcessed: messages.length,
  });

  log.info({ channelId, threadTs, messagesProcessed: messages.length }, "Thread rollup stored");
}

async function handleBackfillRollup(
  workspaceId: string,
  channelId: string,
  windowDays: number = config.SUMMARY_WINDOW_DAYS,
): Promise<void> {
  await materializeBackfillSummary({
    workspaceId,
    channelId,
    windowDays,
    publishEvent: true,
  });
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
