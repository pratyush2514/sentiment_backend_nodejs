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
import {
  parseAndValidate,
  STRICT_RETRY_SUFFIX,
  summarizeRawLlmResponse,
} from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import { sanitizeForExternalUse } from "./privacyFilter.js";
import { normalizeSummaryForLLM } from "./summaryState.js";
import {
  deriveThreadSurfacePriority,
  normalizeCrucialMoments,
} from "./threadInsightPolicy.js";
import type { LLMRawResult } from "./llmProviders.js";
import type {
  CrucialMoment,
  MessageRow,
  OperationalRisk,
  SummaryFact,
  SummaryFactEvidence,
} from "../types/database.js";

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

const EvidenceTsSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

const EvidenceFactSchema = z.object({
  text: z.string().min(1).max(280),
  // Accept any length from LLM, truncate to 3 — models don't reliably follow array length constraints
  evidence_ts: z
    .array(EvidenceTsSchema)
    .min(1)
    .transform((arr) => arr.slice(0, 3)),
});

const StructuredChannelRollupSchema = z.object({
  active_topics: z.array(EvidenceFactSchema).max(6).default([]),
  blockers: z.array(EvidenceFactSchema).max(6).default([]),
  resolutions: z.array(EvidenceFactSchema).max(6).default([]),
  new_decisions: z.array(EvidenceFactSchema).max(10).default([]),
});

const LegacyChannelRollupSchema = z.object({
  summary: z.string().min(1).max(2000),
  new_decisions: z.array(z.string()).max(10),
});

const ThreadRollupSchema = z.object({
  new_decisions: z.array(EvidenceFactSchema).max(10).optional().default([]),
  open_questions: z.array(z.string()).max(10).optional().default([]),
  primary_issue: z.string().min(1).max(300),
  primary_issue_message_ts: EvidenceTsSchema,
  thread_state: ThreadStateSchema,
  emotional_temperature: ThreadEmotionalTemperatureSchema,
  operational_risk: ThreadOperationalRiskSchema,
  surface_priority: ThreadSurfacePrioritySchema,
  crucial_moments: z
    .array(
      z.object({
        messageTs: z.string().regex(/^\d+\.\d+$/),
        kind: z.string().min(1).max(80),
        reason: z.string().min(1).max(240),
        surfacePriority: ThreadSurfacePrioritySchema,
      }),
    )
    .max(8)
    .optional()
    .default([]),
});

type EvidenceFact = z.infer<typeof EvidenceFactSchema>;
type StructuredChannelRollupOutput = z.infer<
  typeof StructuredChannelRollupSchema
>;
type LegacyChannelRollupOutput = z.infer<typeof LegacyChannelRollupSchema>;
type ParserFailure = { success: false; error: unknown };
type ParserSuccess<T> = { success: true; data: T };
type ChannelSummaryStyle = "primary" | "live";
type ChannelRollupParseSuccess =
  | ({ success: true; format: "structured" } & {
      data: StructuredChannelRollupOutput;
    })
  | ({ success: true; format: "legacy" } & { data: LegacyChannelRollupOutput });

interface RollupMessage {
  userId: string;
  displayName: string | null;
  text: string;
  ts: string;
  threadTs?: string | null;
}

export interface RollupResult {
  summary: string;
  keyDecisions: string[];
  summaryFacts: SummaryFact[];
  tokenCount: number;
  raw: LLMRawResult;
  openQuestions?: string[];
}

export interface ThreadRollupResult extends RollupResult {
  primaryIssue: string;
  threadState:
    | "monitoring"
    | "investigating"
    | "blocked"
    | "waiting_external"
    | "resolved"
    | "escalated";
  emotionalTemperature: "calm" | "watch" | "tense" | "escalated";
  operationalRisk: OperationalRisk;
  surfacePriority: "none" | "low" | "medium" | "high";
  crucialMoments: CrucialMoment[];
}

function normalizeThreadRollupResult(
  data: z.infer<typeof ThreadRollupSchema>,
  raw: LLMRawResult,
  allowedTs: ReadonlySet<string>,
  messageIndex: ReadonlyMap<string, SummaryFactEvidence>,
): ThreadRollupResult {
  const supportedDecisionFacts = filterSupportedEvidenceFacts(
    data.new_decisions,
    allowedTs,
    6,
  );
  const supportedDecisions = supportedDecisionFacts.map((fact) => fact.text);
  const crucialMoments = normalizeCrucialMoments(data.crucial_moments);
  const surfacePriority = deriveThreadSurfacePriority({
    threadState: data.thread_state,
    operationalRisk: data.operational_risk,
    emotionalTemperature: data.emotional_temperature,
    surfacePriority: data.surface_priority,
    openQuestions: data.open_questions,
    crucialMoments,
  });
  const primaryIssueFact: SummaryFact = {
    kind: "primary_issue",
    text: normalizeFactText(data.primary_issue),
    evidence: [
      messageIndex.get(data.primary_issue_message_ts),
    ].filter((item): item is SummaryFactEvidence => Boolean(item)),
  };
  const summaryFacts: SummaryFact[] = [
    primaryIssueFact,
    ...buildSummaryFactsFromEvidenceSet(
      "decision",
      supportedDecisionFacts,
      messageIndex,
    ),
  ].filter((fact) => fact.evidence.length > 0);

  return {
    summary: buildThreadSummary({
      primaryIssue: data.primary_issue,
      threadState: data.thread_state,
      operationalRisk: data.operational_risk,
      openQuestions: data.open_questions,
      decisions: supportedDecisions,
    }),
    keyDecisions: supportedDecisions,
    summaryFacts,
    openQuestions: data.open_questions,
    primaryIssue: data.primary_issue,
    threadState: data.thread_state,
    emotionalTemperature: data.emotional_temperature,
    operationalRisk: data.operational_risk,
    surfacePriority,
    crucialMoments,
    tokenCount: estimateTokens(
      buildThreadSummary({
        primaryIssue: data.primary_issue,
        threadState: data.thread_state,
        operationalRisk: data.operational_risk,
        openQuestions: data.open_questions,
        decisions: supportedDecisions,
      }),
    ),
    raw,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function joinFactTexts(facts: string[], limit: number): string {
  const selected = facts.slice(0, limit);
  if (selected.length === 0) return "";

  // Since facts should now be full sentences, we just join them with spaces.
  // Ensure each fact ends with a period if it doesn't already.
  return selected
    .map((fact) => {
      const trimmed = fact.trim();
      return trimmed.endsWith(".") ||
        trimmed.endsWith("?") ||
        trimmed.endsWith("!")
        ? trimmed
        : `${trimmed}.`;
    })
    .join(" ");
}

const SUMMARY_FACT_LIMITS: Record<SummaryFact["kind"], number> = {
  topic: 4,
  blocker: 4,
  resolution: 4,
  decision: MAX_DECISIONS,
  primary_issue: 1,
  open_question: 4,
};

function trimEvidenceExcerpt(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177).trimEnd()}...`;
}

function buildRollupMessageIndex(
  messages: RollupMessage[],
): Map<string, SummaryFactEvidence> {
  return new Map(
    messages.map((message) => [
      message.ts,
      {
        messageTs: message.ts,
        threadTs: message.threadTs ?? null,
        excerpt: trimEvidenceExcerpt(message.text),
      },
    ]),
  );
}

function buildSummaryFactFromEvidence(
  kind: SummaryFact["kind"],
  fact: EvidenceFact,
  messageIndex: ReadonlyMap<string, SummaryFactEvidence>,
): SummaryFact | null {
  const text = normalizeFactText(fact.text);
  if (!text) {
    return null;
  }

  const evidence = fact.evidence_ts
    .map((ts) => messageIndex.get(ts))
    .filter((item): item is SummaryFactEvidence => Boolean(item));
  if (evidence.length === 0) {
    return null;
  }

  return {
    kind,
    text,
    evidence: evidence.slice(0, 3),
  };
}

function buildSummaryFactsFromEvidenceSet(
  kind: SummaryFact["kind"],
  facts: EvidenceFact[],
  messageIndex: ReadonlyMap<string, SummaryFactEvidence>,
): SummaryFact[] {
  const limit = SUMMARY_FACT_LIMITS[kind];
  const summaryFacts: SummaryFact[] = [];

  for (const fact of facts) {
    const summaryFact = buildSummaryFactFromEvidence(kind, fact, messageIndex);
    if (!summaryFact) {
      continue;
    }
    summaryFacts.push(summaryFact);
    if (summaryFacts.length >= limit) {
      break;
    }
  }

  return summaryFacts;
}

function mergeSummaryFactEvidence(
  existing: SummaryFactEvidence[],
  next: SummaryFactEvidence[],
): SummaryFactEvidence[] {
  const merged: SummaryFactEvidence[] = [];
  const seen = new Set<string>();

  for (const evidence of [...existing, ...next]) {
    const key = `${evidence.messageTs}:${evidence.threadTs ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(evidence);
    if (merged.length >= 3) {
      break;
    }
  }

  return merged;
}

function mergeSummaryFacts(
  existing: SummaryFact[],
  next: SummaryFact[],
): SummaryFact[] {
  const merged = [...existing];

  for (const fact of next) {
    const existingIndex = merged.findIndex(
      (candidate) =>
        candidate.kind === fact.kind &&
        candidate.text.toLowerCase() === fact.text.toLowerCase(),
    );

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        evidence: mergeSummaryFactEvidence(
          merged[existingIndex].evidence,
          fact.evidence,
        ),
      };
      continue;
    }

    const limit = SUMMARY_FACT_LIMITS[fact.kind];
    const kindCount = merged.filter((candidate) => candidate.kind === fact.kind)
      .length;
    if (kindCount >= limit) {
      continue;
    }

    merged.push(fact);
  }

  return merged;
}

export function filterSupportedEvidenceFacts(
  facts: EvidenceFact[],
  allowedTs: ReadonlySet<string>,
  limit: number,
): EvidenceFact[] {
  const seen = new Set<string>();
  const supported: EvidenceFact[] = [];

  for (const fact of facts) {
    const text = normalizeFactText(fact.text);
    if (!text) continue;
    if (!fact.evidence_ts.every((ts) => allowedTs.has(ts))) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    supported.push({
      text,
      evidence_ts: [...new Set(fact.evidence_ts)],
    });
    if (supported.length >= limit) break;
  }

  return supported;
}

export function buildChannelSummaryFromFacts(input: {
  topics: EvidenceFact[];
  blockers: EvidenceFact[];
  resolutions: EvidenceFact[];
  decisions: EvidenceFact[];
  fallbackSummary?: string;
  style?: ChannelSummaryStyle;
}): string {
  const style = input.style ?? "primary";
  const sentences: string[] = [];
  const topics = input.topics.map((fact) => fact.text);
  const blockers = input.blockers.map((fact) => fact.text);
  const resolutions = input.resolutions.map((fact) => fact.text);
  const decisions = input.decisions.map((fact) => fact.text);

  if (style === "live") {
    if (topics.length > 0) {
      sentences.push(`Latest activity focused on ${joinFactTexts(topics, 2)}.`);
    }
    if (blockers.length > 0) {
      sentences.push(`New risk to watch: ${joinFactTexts(blockers, 1)}.`);
    } else if (resolutions.length > 0) {
      sentences.push(`Recent progress: ${joinFactTexts(resolutions, 1)}.`);
    }
    if (decisions.length > 0) {
      sentences.push(`Immediate next steps: ${joinFactTexts(decisions, 1)}.`);
    } else if (blockers.length === 0 && resolutions.length > 0) {
      sentences.push(
        `Follow-through now centers on ${joinFactTexts(resolutions, 1)}.`,
      );
    }
  } else {
    if (topics.length > 0) {
      sentences.push(
        `Over the last 7 days, key discussions included: ${joinFactTexts(topics, 4)}`,
      );
    }
    if (blockers.length > 0) {
      sentences.push(`Active blockers or risks: ${joinFactTexts(blockers, 3)}`);
    }
    if (resolutions.length > 0) {
      sentences.push(`Recent progress: ${joinFactTexts(resolutions, 3)}`);
    }
    if (decisions.length > 0) {
      sentences.push(
        `Key decisions and next steps: ${joinFactTexts(decisions, 3)}`,
      );
    }
  }

  const summary = (
    style === "live" ? sentences.slice(0, 3) : sentences.slice(0, 6)
  )
    .join(" ")
    .trim();
  if (summary) {
    return summary;
  }

  if (style === "live") {
    return "";
  }

  const fallback = normalizeFactText(input.fallbackSummary ?? "");
  if (fallback) {
    return fallback;
  }

  return "Recent conversation was mostly routine coordination with no strongly supported blockers or decisions in this batch.";
}

export function buildThreadSummary(input: {
  primaryIssue: string;
  threadState: ThreadRollupResult["threadState"];
  operationalRisk: OperationalRisk;
  openQuestions: string[];
  decisions: string[];
}): string {
  const sentences = [
    `Primary issue: ${normalizeFactText(input.primaryIssue)}.`,
  ];

  switch (input.threadState) {
    case "resolved":
      sentences.push("The thread appears resolved.");
      break;
    case "blocked":
      sentences.push(
        "The thread is currently blocked and needs follow-through.",
      );
      break;
    case "waiting_external":
      sentences.push("The thread is waiting on an external dependency.");
      break;
    case "escalated":
      sentences.push(
        "The thread has escalated and may need manager attention.",
      );
      break;
    case "investigating":
      sentences.push("The thread is still being investigated.");
      break;
    default:
      sentences.push("The thread is being monitored.");
      break;
  }

  if (input.operationalRisk !== "none") {
    sentences.push(`Operational risk remains ${input.operationalRisk}.`);
  }
  if (input.decisions.length > 0) {
    sentences.push(
      `Key decisions or actions: ${joinFactTexts(input.decisions, 2)}.`,
    );
  }
  if (input.openQuestions.length > 0) {
    sentences.push(
      `Open questions remain around ${joinFactTexts(input.openQuestions.map(normalizeFactText), 2)}.`,
    );
  }

  return sentences.join(" ");
}

function parseChannelRollup(
  raw: string,
): ChannelRollupParseSuccess | ParserFailure {
  const structured = parseAndValidate(raw, StructuredChannelRollupSchema);
  if (structured.success) {
    return {
      success: true as const,
      format: "structured" as const,
      data: structured.data,
    };
  }

  const legacy = parseAndValidate(raw, LegacyChannelRollupSchema);
  if (legacy.success) {
    return {
      success: true as const,
      format: "legacy" as const,
      data: legacy.data,
    };
  }

  return {
    success: false as const,
    error: structured.error,
  };
}

function parseThreadRollup(
  raw: string,
): ParserSuccess<z.infer<typeof ThreadRollupSchema>> | ParserFailure {
  return parseAndValidate(raw, ThreadRollupSchema);
}

async function llmChannelRollupWithRetry(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ data: ChannelRollupParseSuccess; raw: LLMRawResult } | null> {
  const provider = createLLMProvider();
  const model = config.LLM_MODEL;

  const result = await provider.chat(systemPrompt, userPrompt, model);
  const first = parseChannelRollup(result.content);
  if (first.success) return { data: first, raw: result };

  log.warn(
    { error: first.error },
    "Channel rollup response validation failed, retrying",
  );

  const retryResult = await provider.chat(
    systemPrompt + STRICT_RETRY_SUFFIX,
    userPrompt,
    model,
  );
  const second = parseChannelRollup(retryResult.content);
  if (second.success) {
    return {
      data: second,
      raw: {
        ...retryResult,
        promptTokens: result.promptTokens + retryResult.promptTokens,
        completionTokens:
          result.completionTokens + retryResult.completionTokens,
      },
    };
  }

  log.error(
    { error: second.error, ...summarizeRawLlmResponse(retryResult.content) },
    "Channel rollup validation failed after retry",
  );
  return null;
}

async function llmThreadRollupWithRetry(
  systemPrompt: string,
  userPrompt: string,
): Promise<{
  data: ParserSuccess<z.infer<typeof ThreadRollupSchema>>;
  raw: LLMRawResult;
} | null> {
  const provider = createLLMProvider();
  const model = config.LLM_MODEL;

  const result = await provider.chat(systemPrompt, userPrompt, model);
  const first = parseThreadRollup(result.content);
  if (first.success) return { data: first, raw: result };

  log.warn(
    { error: first.error },
    "Thread rollup response validation failed, retrying",
  );

  const retryResult = await provider.chat(
    systemPrompt + STRICT_RETRY_SUFFIX,
    userPrompt,
    model,
  );
  const second = parseThreadRollup(retryResult.content);
  if (second.success) {
    return {
      data: second,
      raw: {
        ...retryResult,
        promptTokens: result.promptTokens + retryResult.promptTokens,
        completionTokens:
          result.completionTokens + retryResult.completionTokens,
      },
    };
  }

  log.error(
    { error: second.error, ...summarizeRawLlmResponse(retryResult.content) },
    "Thread rollup validation failed after retry",
  );
  return null;
}

// ─── Channel Rollup ─────────────────────────────────────────────────────────

export async function channelRollup(
  existingSummary: string,
  messages: RollupMessage[],
  existingDecisions: string[],
  canonicalState?: Parameters<
    typeof buildChannelRollupPrompt
  >[0]["canonicalState"],
  options?: {
    summaryStyle?: ChannelSummaryStyle;
  },
): Promise<RollupResult | null> {
  const summaryStyle = options?.summaryStyle ?? "primary";
  const { system, user } = buildChannelRollupPrompt({
    existingSummary: normalizeSummaryForLLM(existingSummary),
    existingDecisions,
    messages,
    canonicalState,
  });

  const result = await llmChannelRollupWithRetry(system, user);
  if (!result) return null;

  if (result.data.format === "legacy") {
    const mergedDecisions =
      summaryStyle === "live"
        ? result.data.data.new_decisions
        : [...existingDecisions, ...result.data.data.new_decisions].slice(
            -MAX_DECISIONS,
          );

    return {
      summary: result.data.data.summary,
      keyDecisions: mergedDecisions,
      summaryFacts: [],
      tokenCount: estimateTokens(result.data.data.summary),
      raw: result.raw,
    };
  }

  const messageIndex = buildRollupMessageIndex(messages);
  const allowedTs = new Set(messageIndex.keys());
  const topics = filterSupportedEvidenceFacts(
    result.data.data.active_topics,
    allowedTs,
    4,
  );
  const blockers = filterSupportedEvidenceFacts(
    result.data.data.blockers,
    allowedTs,
    4,
  );
  const resolutions = filterSupportedEvidenceFacts(
    result.data.data.resolutions,
    allowedTs,
    4,
  );
  const supportedDecisions = filterSupportedEvidenceFacts(
    result.data.data.new_decisions,
    allowedTs,
    6,
  );
  const mergedDecisions =
    summaryStyle === "live"
      ? supportedDecisions.map((fact) => fact.text)
      : [...existingDecisions];
  if (summaryStyle !== "live") {
    for (const decision of supportedDecisions.map((fact) => fact.text)) {
      if (!mergedDecisions.includes(decision)) {
        mergedDecisions.push(decision);
      }
    }
  }
  const summary = buildChannelSummaryFromFacts({
    topics,
    blockers,
    resolutions,
    decisions: supportedDecisions,
    fallbackSummary: existingSummary,
    style: summaryStyle,
  });
  const summaryFacts = [
    ...buildSummaryFactsFromEvidenceSet("topic", topics, messageIndex),
    ...buildSummaryFactsFromEvidenceSet("blocker", blockers, messageIndex),
    ...buildSummaryFactsFromEvidenceSet("resolution", resolutions, messageIndex),
    ...buildSummaryFactsFromEvidenceSet(
      "decision",
      supportedDecisions,
      messageIndex,
    ),
  ];

  return {
    summary,
    keyDecisions: mergedDecisions.slice(-MAX_DECISIONS),
    summaryFacts,
    tokenCount: estimateTokens(summary),
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

  const result = await llmThreadRollupWithRetry(system, user);
  if (!result) return null;

  const allowedTs = new Set(messages.map((message) => message.ts));
  if (!allowedTs.has(result.data.data.primary_issue_message_ts)) {
    log.warn(
      {
        threadTs: _threadTs,
        issueTs: result.data.data.primary_issue_message_ts,
      },
      "Thread rollup primary issue evidence was not present in source messages",
    );
    return null;
  }

  const messageIndex = buildRollupMessageIndex(messages);
  return normalizeThreadRollupResult(
    result.data.data,
    result.raw,
    allowedTs,
    messageIndex,
  );
}

// ─── Backfill Summarization (Hierarchical Compression) ──────────────────────

export async function backfillSummarize(
  workspaceId: string,
  channelId: string,
  windowDays: number = config.SUMMARY_WINDOW_DAYS,
): Promise<{
  summary: string;
  keyDecisions: string[];
  summaryFacts: SummaryFact[];
  sourceTsStart: string | null;
  sourceTsEnd: string | null;
  messageCount: number;
  partial: boolean;
  degradedReasons: string[];
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
  let allSummaryFacts: SummaryFact[] = [];
  let cursorTs: string | null = null;
  let totalMessages = 0;
  let batchCount = 0;
  let sourceTsStart: string | null = null;
  let sourceTsEnd: string | null = null;
  let budgetTruncated = false;

  log.info(
    { channelId, windowDays: safeWindowDays },
    "Starting backfill summarization (time-windowed)",
  );

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
        text:
          sanitized.action === "redacted"
            ? sanitized.text
            : sanitized.action === "skipped"
              ? "[message contained sensitive content]"
              : rawText,
        ts: m.ts,
        threadTs: m.thread_ts,
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
      log.warn(
        { dailyCost, budget: config.LLM_DAILY_BUDGET_USD },
        "Budget exceeded during backfill summarization, stopping",
      );
      budgetTruncated = true;
      break;
    }

    const result = await channelRollup(
      leafSummaries.length > 0 ? leafSummaries[leafSummaries.length - 1] : "",
      batch,
      allDecisions,
    );

    if (result) {
      leafSummaries.push(result.summary);
      allDecisions.push(
        ...result.keyDecisions.filter((d) => !allDecisions.includes(d)),
      );
      allSummaryFacts = mergeSummaryFacts(allSummaryFacts, result.summaryFacts);
    }
  }

  log.info(
    { channelId, batches: batchCount, totalMessages },
    "Backfill summarization batches prepared",
  );

  if (leafSummaries.length === 0) {
    return null;
  }

  // If only one batch, use its summary directly
  if (leafSummaries.length === 1) {
    return {
      summary: leafSummaries[0],
      keyDecisions: allDecisions.slice(-MAX_DECISIONS),
      summaryFacts: allSummaryFacts,
      sourceTsStart,
      sourceTsEnd,
      messageCount: totalMessages,
      partial: budgetTruncated,
      degradedReasons: budgetTruncated ? ["budget_truncated"] : [],
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
      summaryFacts: allSummaryFacts,
      sourceTsStart,
      sourceTsEnd,
      messageCount: totalMessages,
      partial: true,
      degradedReasons: [
        "meta_summary_fallback",
        ...(budgetTruncated ? ["budget_truncated"] : []),
      ],
    };
  }

  return {
    summary: metaResult.summary,
    keyDecisions: metaResult.keyDecisions,
    summaryFacts: allSummaryFacts,
    sourceTsStart,
    sourceTsEnd,
    messageCount: totalMessages,
    partial: budgetTruncated,
    degradedReasons: budgetTruncated ? ["budget_truncated"] : [],
  };
}
