import { z } from "zod/v4";
import { config } from "../config.js";
import { buildSingleMessagePrompt } from "../prompts/singleMessage.js";
import { buildThreadAnalysisPrompt } from "../prompts/threadAnalysis.js";
import { logger } from "../utils/logger.js";
import {
  parseAndValidate,
  STRICT_RETRY_SUFFIX,
  summarizeRawLlmResponse,
} from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import type { LLMRawResult } from "./llmProviders.js";
import type { ContextPack } from "../prompts/singleMessage.js";
import type { ThreadContextPack } from "../prompts/threadAnalysis.js";

const log = logger.child({ module: "emotionAnalyzer" });

// ─── Zod validation schemas ─────────────────────────────────────────────────

const emotionEnum = z.enum([
  "anger",
  "disgust",
  "fear",
  "joy",
  "neutral",
  "sadness",
  "surprise",
]);

const intentEnum = z.enum([
  "request",
  "question",
  "decision",
  "commitment",
  "blocker",
  "escalation",
  "fyi",
  "acknowledgment",
]);

const urgencyEnum = z.enum(["none", "low", "medium", "high", "critical"]);

const interactionToneEnum = z.enum([
  "neutral",
  "collaborative",
  "corrective",
  "tense",
  "confrontational",
  "dismissive",
]);

const MessageAnalysisSchema = z.object({
  dominant_emotion: emotionEnum,
  interaction_tone: interactionToneEnum.optional().default("neutral"),
  confidence: z.number().min(0).max(1),
  escalation_risk: z.enum(["low", "medium", "high"]),
  sarcasm_detected: z.boolean(),
  intended_emotion: emotionEnum.optional(),
  explanation: z.string().min(1).max(2000),
  trigger_phrases: z.array(z.string()).max(5).default([]),
  message_intent: intentEnum.optional().default("fyi"),
  is_actionable: z.boolean().optional().default(false),
  is_blocking: z.boolean().optional().default(false),
  urgency_level: urgencyEnum.optional().default("none"),
});

const ThreadAnalysisSchema = MessageAnalysisSchema.extend({
  thread_sentiment: z.string().min(1).max(500),
  sentiment_trajectory: z.enum(["improving", "stable", "deteriorating"]),
  summary: z.string().min(1).max(1000),
  open_questions: z.array(z.string()).max(10).optional().default([]),
});

export type MessageAnalysis = z.infer<typeof MessageAnalysisSchema>;
export type ThreadAnalysis = z.infer<typeof ThreadAnalysisSchema>;

export interface AnalysisSuccess<T> {
  status: "success";
  data: T;
  raw: LLMRawResult;
}

export interface AnalysisFailure {
  status: "failed";
  rawResponse: string;
  error: string;
  raw: LLMRawResult;
}

export type AnalysisResult<T> = AnalysisSuccess<T> | AnalysisFailure;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateTriggerPhrases<T extends MessageAnalysis>(
  data: T,
  messageText: string,
): T {
  if (!data.trigger_phrases || data.trigger_phrases.length === 0) return data;
  const lowerText = messageText.toLowerCase();
  return {
    ...data,
    trigger_phrases: data.trigger_phrases.filter((phrase) =>
      lowerText.includes(phrase.toLowerCase()),
    ),
  };
}

function isLikelySharpButNotHostile(messageText: string): boolean {
  const lower = messageText.toLowerCase();
  const strongHostilitySignals = [
    "ridiculous",
    "unacceptable",
    "what the hell",
    "wtf",
    "nonsense",
    "stop doing this",
    "this is stupid",
    "useless",
    "lazy",
    "idiot",
    "are you even",
  ];

  if (strongHostilitySignals.some((signal) => lower.includes(signal))) {
    return false;
  }

  const correctiveSignals = [
    "please read",
    "before sending",
    "before sharing",
    "please check",
    "maybe you didn't",
    "maybe you did not",
    "you need to",
    "read the diagram",
    "read the doc",
    "read the thread",
  ];

  return correctiveSignals.some((signal) => lower.includes(signal));
}

export function calibrateMessageAnalysis(
  data: MessageAnalysis,
  messageText: string,
): MessageAnalysis {
  const shouldDowngradeCorrectiveAnger =
    data.dominant_emotion === "anger" &&
    data.interaction_tone === "corrective" &&
    !data.sarcasm_detected &&
    data.escalation_risk !== "high" &&
    isLikelySharpButNotHostile(messageText);

  if (!shouldDowngradeCorrectiveAnger) {
    return data;
  }

  return {
    ...data,
    dominant_emotion: "neutral",
    confidence: Math.min(data.confidence, 0.74),
    explanation:
      "This reads as direct corrective feedback rather than clear anger. The sender is pushing for a change in how the work is prepared, but the wording does not show overt hostility, insult, or emotional venting. Treat it as communication friction to monitor, not a strong anger signal.",
  };
}

// ─── Single message analysis ─────────────────────────────────────────────────

export async function analyzeMessage(
  context: ContextPack,
): Promise<AnalysisResult<MessageAnalysis>> {
  const provider = createLLMProvider();
  const { system, user } = buildSingleMessagePrompt(context);

  const result = await provider.chat(system, user, config.LLM_MODEL);

  // First attempt validation
  const first = parseAndValidate(result.content, MessageAnalysisSchema);
  if (first.success) {
    return {
      status: "success",
      data: calibrateMessageAnalysis(
        validateTriggerPhrases(first.data, context.messageText),
        context.messageText,
      ),
      raw: result,
    };
  }

  log.warn(
    { error: first.error, provider: provider.name },
    "LLM response validation failed, retrying with stricter prompt",
  );

  // Retry with stricter prompt
  const retryResult = await provider.chat(
    system + STRICT_RETRY_SUFFIX,
    user,
    config.LLM_MODEL,
  );

  const second = parseAndValidate(retryResult.content, MessageAnalysisSchema);
  if (second.success) {
    // Merge token counts from both attempts
    return {
      status: "success",
      data: calibrateMessageAnalysis(
        validateTriggerPhrases(second.data, context.messageText),
        context.messageText,
      ),
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
    "LLM response validation failed after retry",
  );

  return {
    status: "failed",
    rawResponse: retryResult.content,
    error: second.error,
    raw: {
      ...retryResult,
      promptTokens: result.promptTokens + retryResult.promptTokens,
      completionTokens: result.completionTokens + retryResult.completionTokens,
    },
  };
}

// ─── Thread analysis ─────────────────────────────────────────────────────────

export async function analyzeThread(
  context: ThreadContextPack,
): Promise<AnalysisResult<ThreadAnalysis>> {
  const provider = createLLMProvider();
  const { system, user } = buildThreadAnalysisPrompt(context);

  const threadText = context.messages.map((m) => m.text).join(" ");
  const result = await provider.chat(system, user, config.LLM_MODEL_THREAD);

  const first = parseAndValidate(result.content, ThreadAnalysisSchema);
  if (first.success) {
    return {
      status: "success",
      data: validateTriggerPhrases(first.data, threadText),
      raw: result,
    };
  }

  log.warn(
    { error: first.error, provider: provider.name },
    "Thread analysis validation failed, retrying with stricter prompt",
  );

  const retryResult = await provider.chat(
    system + STRICT_RETRY_SUFFIX,
    user,
    config.LLM_MODEL_THREAD,
  );

  const second = parseAndValidate(retryResult.content, ThreadAnalysisSchema);
  if (second.success) {
    return {
      status: "success",
      data: validateTriggerPhrases(second.data, threadText),
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
    "Thread analysis validation failed after retry",
  );

  return {
    status: "failed",
    rawResponse: retryResult.content,
    error: second.error,
    raw: {
      ...retryResult,
      promptTokens: result.promptTokens + retryResult.promptTokens,
      completionTokens: result.completionTokens + retryResult.completionTokens,
    },
  };
}
