import { config } from "../../config.js";
import { CHANNEL_MESSAGE_LIMIT, THREAD_MESSAGE_LIMIT, TARGET_MESSAGE_COUNT } from "../../constants.js";
import * as db from "../../db/queries.js";
import { checkAndAlert, alertBudgetExceeded } from "../../services/alerting.js";
import { assembleContext } from "../../services/contextAssembler.js";
import { estimateCost } from "../../services/costEstimator.js";
import { analyzeMessage, analyzeThread } from "../../services/emotionAnalyzer.js";
import { sanitizeForExternalUse } from "../../services/privacyFilter.js";
import { computeRiskScore } from "../../services/riskHeuristic.js";
import { logger } from "../../utils/logger.js";
import type { DominantEmotion, EscalationRisk } from "../../types/database.js";
import type { LLMAnalyzeJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "llmAnalyze" });

export async function handleLLMAnalyze(
  jobs: Job<LLMAnalyzeJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, triggerType, threadTs } = job.data;

    log.info({ jobId: job.id, channelId, triggerType, threadTs }, "Starting LLM analysis");

    // 1. Budget check
    const dailyCost = await db.getDailyLLMCost(workspaceId);
    if (dailyCost >= config.LLM_DAILY_BUDGET_USD) {
      alertBudgetExceeded(workspaceId, dailyCost, config.LLM_DAILY_BUDGET_USD);
      log.warn({ dailyCost, budget: config.LLM_DAILY_BUDGET_USD }, "Budget exceeded, skipping");
      return;
    }

    // 2. Fetch messages
    const isThread = !!threadTs;
    const limit = isThread ? THREAD_MESSAGE_LIMIT : CHANNEL_MESSAGE_LIMIT;
    const messages = await db.getMessages(workspaceId, channelId, {
      limit,
      threadTs: threadTs ?? null,
    });

    if (messages.length === 0) {
      log.warn({ channelId, threadTs }, "No messages found for analysis");
      return;
    }

    // 3. Privacy filter: sanitize message text before any external LLM/embedding calls
    const recentMsgs = messages.map((m) => {
      const rawText = m.normalized_text ?? m.text;
      const sanitized = sanitizeForExternalUse(rawText);
      return {
        userId: m.user_id,
        text: sanitized.action === "redacted" ? sanitized.text : sanitized.action === "skipped" ? "" : rawText,
        ts: m.ts,
        privacySkipped: sanitized.action === "skipped",
      };
    });

    // If the target message (latest) was skipped for privacy, mark and bail
    const targetMessages = messages.slice(-TARGET_MESSAGE_COUNT);
    const latestSanitized = recentMsgs[recentMsgs.length - 1];
    if (latestSanitized.privacySkipped) {
      log.info({ channelId }, "Target message skipped due to privacy filter");
      for (const msg of targetMessages) {
        await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "skipped");
      }
      return;
    }

    // 4. Assemble rich context (summary + decisions + pgvector + recent messages)
    const contextMsgs = recentMsgs.map(({ userId, text, ts }) => ({ userId, text, ts }));
    const targetText = recentMsgs.slice(-TARGET_MESSAGE_COUNT).map((m) => m.text).join(" ");
    const assembled = await assembleContext(workspaceId, channelId, targetText, contextMsgs);
    const runningSummary = assembled.runningSummary;
    const keyDecisions = assembled.keyDecisions;
    const relevantDocuments = assembled.relevantDocuments;

    const channelState = await db.getChannelState(workspaceId, channelId);

    // 5. Skip if the latest message was already analyzed (avoid redundant LLM calls)
    const latestMsg = targetMessages[targetMessages.length - 1];
    if (latestMsg.analysis_status === "completed") {
      log.info({ channelId, messageTs: latestMsg.ts }, "Latest message already analyzed, skipping");
      return;
    }

    for (const msg of targetMessages) {
      await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "processing");
    }

    // 5b. Compute risk score for the latest message (shared with LLM as a hint)
    const latestSanitizedText = recentMsgs[recentMsgs.length - 1].text;
    const riskScore = computeRiskScore(latestSanitizedText);

    // 5. Run analysis
    let analysisEscalationRisk: string | undefined;
    try {
      if (isThread) {
        // Thread analysis
        const result = await analyzeThread({
          runningSummary,
          keyDecisions,
          relevantDocuments,
          riskScore,
          messages: contextMsgs,
        });

        if (result.status === "failed") {
          log.warn({ channelId, threadTs, error: result.error }, "Thread analysis failed");
          for (const msg of targetMessages) {
            await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "failed");
          }
          // Still record cost for failed attempts
          await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
          return;
        }

        // Store analytics for the latest message in the thread
        analysisEscalationRisk = result.data.escalation_risk;
        const latestMsg = targetMessages[targetMessages.length - 1];
        await db.insertMessageAnalytics({
          workspaceId,
          channelId,
          messageTs: latestMsg.ts,
          dominantEmotion: result.data.dominant_emotion as DominantEmotion,
          confidence: result.data.confidence,
          escalationRisk: result.data.escalation_risk as EscalationRisk,
          themes: [],
          decisionSignal: false,
          explanation: result.data.explanation,
          rawLlmResponse: result.data as unknown as Record<string, unknown>,
          llmProvider: config.LLM_PROVIDER,
          llmModel: result.raw.model,
          tokenUsage: {
            promptTokens: result.raw.promptTokens,
            completionTokens: result.raw.completionTokens,
          },
        });

        await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);

        // Mark completed
        for (const msg of targetMessages) {
          await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "completed");
        }

        // Check alerts
        checkAndAlert(result.data, { workspaceId, channelId, threadTs: threadTs ?? undefined });
      } else {
        // Single-message / channel analysis — analyze the latest message with surrounding context
        const latestMsg = targetMessages[targetMessages.length - 1];
        // Pass preceding messages as context (everything except the target message)
        const precedingMessages = contextMsgs.filter((m) => m.ts !== latestMsg.ts);
        const result = await analyzeMessage({
          runningSummary,
          keyDecisions,
          relevantDocuments,
          riskScore,
          messageText: latestSanitizedText,
          recentMessages: precedingMessages.length > 0 ? precedingMessages : undefined,
        });

        if (result.status === "failed") {
          log.warn({ channelId, messageTs: latestMsg.ts, error: result.error }, "Message analysis failed");
          for (const msg of targetMessages) {
            await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "failed");
          }
          await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
          return;
        }

        analysisEscalationRisk = result.data.escalation_risk;
        await db.insertMessageAnalytics({
          workspaceId,
          channelId,
          messageTs: latestMsg.ts,
          dominantEmotion: result.data.dominant_emotion as DominantEmotion,
          confidence: result.data.confidence,
          escalationRisk: result.data.escalation_risk as EscalationRisk,
          themes: [],
          decisionSignal: false,
          explanation: result.data.explanation,
          rawLlmResponse: result.data as unknown as Record<string, unknown>,
          llmProvider: config.LLM_PROVIDER,
          llmModel: result.raw.model,
          tokenUsage: {
            promptTokens: result.raw.promptTokens,
            completionTokens: result.raw.completionTokens,
          },
        });

        await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);

        // Mark completed
        for (const msg of targetMessages) {
          await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "completed");
        }

        // Check alerts
        checkAndAlert(result.data, { workspaceId, channelId, messageTs: latestMsg.ts });
      }

      // 6. Update channel state sentiment snapshot
      if (channelState) {
        const snapshot = channelState.sentiment_snapshot_json ?? {
          totalMessages: 0,
          highRiskCount: 0,
          updatedAt: "",
        };
        const wasHighRisk = analysisEscalationRisk === "high" ? 1 : 0;
        await db.upsertChannelState(workspaceId, channelId, {
          sentiment_snapshot_json: {
            // Only count channel messages toward totalMessages, not thread replies
            totalMessages: isThread
              ? snapshot.totalMessages
              : snapshot.totalMessages + targetMessages.length,
            highRiskCount: snapshot.highRiskCount + wasHighRisk,
            updatedAt: new Date().toISOString(),
          },
        });
      }

      log.info({ jobId: job.id, channelId, triggerType }, "LLM analysis complete");
    } catch (err) {
      log.error({ err, channelId, triggerType }, "LLM analysis threw unexpected error");
      for (const msg of targetMessages) {
        await db.updateMessageAnalysisStatus(workspaceId, channelId, msg.ts, "failed");
      }
      throw err; // Re-throw for pg-boss retry
    }
  }
}

async function recordCost(
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
    llmProvider: config.LLM_PROVIDER,
    llmModel: model,
    promptTokens,
    completionTokens,
    estimatedCostUsd: cost,
    jobType: "llm.analyze",
  });
}
