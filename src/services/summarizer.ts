import { z } from "zod/v4";
import { config } from "../config.js";
import { BACKFILL_BATCH_SIZE, MAX_DECISIONS } from "../constants.js";
import {
  ThreadEmotionalTemperatureSchema,
  ThreadOperationalRiskSchema,
  ThreadStateSchema,
  ThreadSurfacePrioritySchema,
} from "../contracts/threadRollup.js";
import * as db from "../db/queries.js";
import { buildChannelRollupPrompt } from "../prompts/channelRollup.js";
import { buildThreadRollupPrompt } from "../prompts/threadRollup.js";
import { logger } from "../utils/logger.js";
import { clampAnalysisWindowDays } from "./analysisWindow.js";
import { parseAndValidate, STRICT_RETRY_SUFFIX, summarizeRawLlmResponse } from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import { sanitizeForExternalUse } from "./privacyFilter.js";
import { normalizeSummaryForLLM } from "./summaryState.js";
import { deriveThreadSurfacePriority, normalizeCrucialMoments } from "./threadInsightPolicy.js";
import type { LLMRawResult } from "./llmProviders.js";
import type { CrucialMoment, MessageRow, OperationalRisk } from "../types/database.js";

const log = logger.child({ module: "summarizer" });

// ─── Token estimation ───────────────────────────────────────────────────────

/** Approximate token count: ~1 token per 4 characters */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to fit within a token budget */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

// ─── Zod schema for rollup output ───────────────────────────────────────────

const RollupSchema = z.object({
  summary: z.string().min(1).max(2000),
  new_decisions: z.array(z.string()).max(10),
});

const ThreadRollupSchema = RollupSchema.extend({
  open_questions: z.array(z.string()).max(10).optional().default([]),
  primary_issue: z.string().min(1).max(300),
  thread_state: ThreadStateSchema,
  emotional_temperature: ThreadEmotionalTemperatureSchema,
  operational_risk: ThreadOperationalRiskSchema,
  surface_priority: ThreadSurfacePrioritySchema,
  crucial_moments: z.array(
    z.object({
      messageTs: z.string().regex(/^\d+\.\d+$/),
      kind: z.string().min(1).max(80),
      reason: z.string().min(1).max(240),
      surfacePriority: ThreadSurfacePrioritySchema,
    }),
  ).max(8).optional().default([]),
});

type RollupOutput = z.infer<typeof RollupSchema>;

export interface RollupResult {
  summary: string;
  keyDecisions: string[];
  tokenCount: number;
  raw: LLMRawResult;
  openQuestions?: string[];
}

export interface ThreadRollupResult extends RollupResult {
  primaryIssue: string;
  threadState: "monitoring" | "investigating" | "blocked" | "waiting_external" | "resolved" | "escalated";
  emotionalTemperature: "calm" | "watch" | "tense" | "escalated";
  operationalRisk: OperationalRisk;
  surfacePriority: "none" | "low" | "medium" | "high";
  crucialMoments: CrucialMoment[];
}

function normalizeThreadRollupResult(
  data: z.infer<typeof ThreadRollupSchema>,
  raw: LLMRawResult,
): ThreadRollupResult {
  const crucialMoments = normalizeCrucialMoments(data.crucial_moments);
  const surfacePriority = deriveThreadSurfacePriority({
    threadState: data.thread_state,
    operationalRisk: data.operational_risk,
    emotionalTemperature: data.emotional_temperature,
    surfacePriority: data.surface_priority,
    openQuestions: data.open_questions,
    crucialMoments,
  });

  return {
    summary: data.summary,
    keyDecisions: data.new_decisions,
    openQuestions: data.open_questions,
    primaryIssue: data.primary_issue,
    threadState: data.thread_state,
    emotionalTemperature: data.emotional_temperature,
    operationalRisk: data.operational_risk,
    surfacePriority,
    crucialMoments,
    tokenCount: estimateTokens(data.summary),
    raw,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseRollup(raw: string) {
  return parseAndValidate(raw, RollupSchema);
}

async function llmCallWithRetry(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ data: RollupOutput; raw: LLMRawResult } | null> {
  const provider = createLLMProvider();
  const model = config.LLM_MODEL; // Use cheap model for summarization

  const result = await provider.chat(systemPrompt, userPrompt, model);
  const first = parseRollup(result.content);
  if (first.success) return { data: first.data, raw: result };

  log.warn({ error: first.error }, "Rollup LLM response validation failed, retrying");

  const retryResult = await provider.chat(systemPrompt + STRICT_RETRY_SUFFIX, userPrompt, model);
  const second = parseRollup(retryResult.content);
  if (second.success) {
    return {
      data: second.data,
      raw: {
        ...retryResult,
        promptTokens: result.promptTokens + retryResult.promptTokens,
        completionTokens: result.completionTokens + retryResult.completionTokens,
      },
    };
  }

  log.error(
    { error: second.error, ...summarizeRawLlmResponse(retryResult.content) },
    "Rollup validation failed after retry",
  );
  return null;
}

// ─── Channel Rollup ─────────────────────────────────────────────────────────

interface RollupMessage {
  userId: string;
  displayName: string | null;
  text: string;
  ts: string;
}

export async function channelRollup(
  existingSummary: string,
  messages: RollupMessage[],
  existingDecisions: string[],
  canonicalState?: Parameters<typeof buildChannelRollupPrompt>[0]["canonicalState"],
): Promise<RollupResult | null> {
  const { system, user } = buildChannelRollupPrompt({
    existingSummary: normalizeSummaryForLLM(existingSummary),
    existingDecisions,
    messages,
    canonicalState,
  });

  const result = await llmCallWithRetry(system, user);
  if (!result) return null;

  // Merge new decisions with existing (cap at 20, drop oldest)
  const mergedDecisions = [...existingDecisions, ...result.data.new_decisions].slice(-MAX_DECISIONS);

  return {
    summary: result.data.summary,
    keyDecisions: mergedDecisions,
    tokenCount: estimateTokens(result.data.summary),
    raw: result.raw,
  };
}

// ─── Thread Rollup ──────────────────────────────────────────────────────────

export async function threadRollup(
  _threadTs: string,
  messages: RollupMessage[],
  channelSummary: string,
): Promise<ThreadRollupResult | null> {
  const { system, user } = buildThreadRollupPrompt({
    channelSummary: normalizeSummaryForLLM(channelSummary),
    messages,
  });

  const provider = createLLMProvider();
  const model = config.LLM_MODEL;

  const rawResult = await provider.chat(system, user, model);
  const first = parseAndValidate(rawResult.content, ThreadRollupSchema);
  if (first.success) {
    return normalizeThreadRollupResult(first.data, rawResult);
  }

  log.warn({ error: first.error }, "Thread rollup LLM response validation failed, retrying");
  const retryResult = await provider.chat(system + STRICT_RETRY_SUFFIX, user, model);
  const second = parseAndValidate(retryResult.content, ThreadRollupSchema);
  if (second.success) {
    return normalizeThreadRollupResult(second.data, {
      ...retryResult,
      promptTokens: rawResult.promptTokens + retryResult.promptTokens,
      completionTokens: rawResult.completionTokens + retryResult.completionTokens,
    });
  }

  log.error(
    { error: second.error, ...summarizeRawLlmResponse(retryResult.content) },
    "Thread rollup validation failed after retry",
  );
  return null;
}

// ─── Backfill Summarization (Hierarchical Compression) ──────────────────────

export async function backfillSummarize(
  workspaceId: string,
  channelId: string,
  windowDays: number = config.SUMMARY_WINDOW_DAYS,
): Promise<{
  summary: string;
  keyDecisions: string[];
  sourceTsStart: string | null;
  sourceTsEnd: string | null;
  messageCount: number;
} | null> {
  const safeWindowDays = clampAnalysisWindowDays(windowDays);
  const userIds = await db.getDistinctUserIds(workspaceId, channelId);
  if (userIds.length === 0) {
    log.info({ channelId }, "No messages for backfill summarization");
    return null;
  }

  const profiles = await db.getUserProfiles(workspaceId, userIds);
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
  const leafSummaries: string[] = [];
  const allDecisions: string[] = [];
  let cursorTs: string | null = null;
  let totalMessages = 0;
  let batchCount = 0;
  let sourceTsStart: string | null = null;
  let sourceTsEnd: string | null = null;

  log.info({ channelId, windowDays: safeWindowDays }, "Starting backfill summarization (time-windowed)");

  while (true) {
    const batchMessages: MessageRow[] = await db.getMessagesInWindow(
      workspaceId,
      channelId,
      safeWindowDays,
      cursorTs,
      BACKFILL_BATCH_SIZE,
    );
    if (batchMessages.length === 0) {
      break;
    }

    const batch: RollupMessage[] = batchMessages.map((m) => {
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

    batchCount += 1;
    totalMessages += batch.length;
    sourceTsStart = sourceTsStart ?? batchMessages[0]?.ts ?? null;
    sourceTsEnd = batchMessages[batchMessages.length - 1]?.ts ?? sourceTsEnd;
    cursorTs = batchMessages[batchMessages.length - 1]?.ts ?? cursorTs;

    // Budget check before each batch
    const dailyCost = await db.getDailyLLMCost(workspaceId);
    if (dailyCost >= config.LLM_DAILY_BUDGET_USD) {
      log.warn({ dailyCost, budget: config.LLM_DAILY_BUDGET_USD }, "Budget exceeded during backfill summarization, stopping");
      break;
    }

    const result = await channelRollup(
      leafSummaries.length > 0 ? leafSummaries[leafSummaries.length - 1] : "",
      batch,
      allDecisions,
    );

    if (result) {
      leafSummaries.push(result.summary);
      allDecisions.push(...result.keyDecisions.filter((d) => !allDecisions.includes(d)));
    }
  }

  log.info({ channelId, batches: batchCount, totalMessages }, "Backfill summarization batches prepared");

  if (leafSummaries.length === 0) {
    return null;
  }

  // If only one batch, use its summary directly
  if (leafSummaries.length === 1) {
    return {
      summary: leafSummaries[0],
      keyDecisions: allDecisions.slice(-MAX_DECISIONS),
      sourceTsStart,
      sourceTsEnd,
      messageCount: totalMessages,
    };
  }

  // Meta-summarize leaf summaries
  const metaMessages: RollupMessage[] = leafSummaries.map((s, i) => ({
    userId: "system",
    displayName: `Batch ${i + 1}`,
    text: s,
    ts: String(i),
  }));

  const metaResult = await channelRollup("", metaMessages, allDecisions);
  if (!metaResult) {
    // Fall back to last leaf summary
    return {
      summary: leafSummaries[leafSummaries.length - 1],
      keyDecisions: allDecisions.slice(-MAX_DECISIONS),
      sourceTsStart,
      sourceTsEnd,
      messageCount: totalMessages,
    };
  }

  return {
    summary: metaResult.summary,
    keyDecisions: metaResult.keyDecisions,
    sourceTsStart,
    sourceTsEnd,
    messageCount: totalMessages,
  };
}
