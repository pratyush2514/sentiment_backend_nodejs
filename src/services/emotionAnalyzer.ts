import { z } from "zod/v4";
import { config } from "../config.js";
import { buildSingleMessagePrompt } from "../prompts/singleMessage.js";
import { buildThreadAnalysisPrompt } from "../prompts/threadAnalysis.js";
import { logger } from "../utils/logger.js";
import { parseAndValidate, STRICT_RETRY_SUFFIX } from "./llmHelpers.js";
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

const MessageAnalysisSchema = z.object({
  dominant_emotion: emotionEnum,
  confidence: z.number().min(0).max(1),
  escalation_risk: z.enum(["low", "medium", "high"]),
  sarcasm_detected: z.boolean(),
  intended_emotion: emotionEnum.optional(),
  explanation: z.string().min(1).max(800),
});

const ThreadAnalysisSchema = MessageAnalysisSchema.extend({
  thread_sentiment: z.string().min(1).max(500),
  sentiment_trajectory: z.enum(["improving", "stable", "deteriorating"]),
  summary: z.string().min(1).max(1000),
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
    return { status: "success", data: first.data, raw: result };
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
      data: second.data,
      raw: {
        ...retryResult,
        promptTokens: result.promptTokens + retryResult.promptTokens,
        completionTokens: result.completionTokens + retryResult.completionTokens,
      },
    };
  }

  log.error(
    { error: second.error, rawResponse: retryResult.content },
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

  const result = await provider.chat(system, user, config.LLM_MODEL_THREAD);

  const first = parseAndValidate(result.content, ThreadAnalysisSchema);
  if (first.success) {
    return { status: "success", data: first.data, raw: result };
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
      data: second.data,
      raw: {
        ...retryResult,
        promptTokens: result.promptTokens + retryResult.promptTokens,
        completionTokens: result.completionTokens + retryResult.completionTokens,
      },
    };
  }

  log.error(
    { error: second.error, rawResponse: retryResult.content },
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
