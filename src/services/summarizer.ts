import { z } from "zod/v4";
import { config } from "../config.js";
import { BACKFILL_BATCH_SIZE, MAX_DECISIONS } from "../constants.js";
import * as db from "../db/queries.js";
import { buildChannelRollupPrompt } from "../prompts/channelRollup.js";
import { buildThreadRollupPrompt } from "../prompts/threadRollup.js";
import { logger } from "../utils/logger.js";
import { parseAndValidate, STRICT_RETRY_SUFFIX } from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import { sanitizeForExternalUse } from "./privacyFilter.js";
import type { LLMRawResult } from "./llmProviders.js";

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

type RollupOutput = z.infer<typeof RollupSchema>;

export interface RollupResult {
  summary: string;
  keyDecisions: string[];
  tokenCount: number;
  raw: LLMRawResult;
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

  log.error({ error: second.error, rawResponse: retryResult.content }, "Rollup validation failed after retry");
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
): Promise<RollupResult | null> {
  const { system, user } = buildChannelRollupPrompt({
    existingSummary,
    existingDecisions,
    messages,
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
): Promise<RollupResult | null> {
  const { system, user } = buildThreadRollupPrompt({
    channelSummary,
    messages,
  });

  const result = await llmCallWithRetry(system, user);
  if (!result) return null;

  return {
    summary: result.data.summary,
    keyDecisions: result.data.new_decisions,
    tokenCount: estimateTokens(result.data.summary),
    raw: result.raw,
  };
}

// ─── Backfill Summarization (Hierarchical Compression) ──────────────────────

export async function backfillSummarize(
  workspaceId: string,
  channelId: string,
): Promise<{ summary: string; keyDecisions: string[] } | null> {
  const allMessages = await db.getMessages(workspaceId, channelId, { limit: BACKFILL_BATCH_SIZE });

  if (allMessages.length === 0) {
    log.info({ channelId }, "No messages for backfill summarization");
    return null;
  }

  // Resolve user profiles for display names
  const userIds = [...new Set(allMessages.map((m) => m.user_id))];
  const profiles = await db.getUserProfiles(workspaceId, userIds);
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));

  const enrichedMessages: RollupMessage[] = allMessages.map((m) => {
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

  // Batch into groups
  const batches: RollupMessage[][] = [];
  for (let i = 0; i < enrichedMessages.length; i += BACKFILL_BATCH_SIZE) {
    batches.push(enrichedMessages.slice(i, i + BACKFILL_BATCH_SIZE));
  }

  log.info({ channelId, batches: batches.length, totalMessages: enrichedMessages.length }, "Starting backfill summarization");

  // Summarize each batch (leaf summaries)
  const leafSummaries: string[] = [];
  const allDecisions: string[] = [];

  for (const batch of batches) {
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

  if (leafSummaries.length === 0) {
    return null;
  }

  // If only one batch, use its summary directly
  if (leafSummaries.length === 1) {
    return { summary: leafSummaries[0], keyDecisions: allDecisions.slice(-MAX_DECISIONS) };
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
    return { summary: leafSummaries[leafSummaries.length - 1], keyDecisions: allDecisions.slice(-MAX_DECISIONS) };
  }

  return { summary: metaResult.summary, keyDecisions: metaResult.keyDecisions };
}
