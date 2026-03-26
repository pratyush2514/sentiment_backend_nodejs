import { config } from "../../config.js";
import { CHANNEL_MESSAGE_LIMIT, THREAD_MESSAGE_LIMIT, TARGET_MESSAGE_COUNT } from "../../constants.js";
import * as db from "../../db/queries.js";
import { checkAndAlert, alertBudgetExceeded, sendSentimentAlertDMs } from "../../services/alerting.js";
import { isTsWithinAnalysisWindow, resolveAnalysisWindowDays } from "../../services/analysisWindow.js";
import { persistCanonicalChannelState } from "../../services/canonicalChannelState.js";
import { assembleContext } from "../../services/contextAssembler.js";
import { estimateCost } from "../../services/costEstimator.js";
import { analyzeMessage } from "../../services/emotionAnalyzer.js";
import { eventBus } from "../../services/eventBus.js";
import { computeContextSLA, resolveOwnershipLanes } from "../../services/followUpMonitor.js";
import { clearFollowUpReminderDms } from "../../services/followUpReminderDms.js";
import {
  recordIntelligenceDegradation,
  recordMessageTruthCompleted,
  recordMessageTruthFailed,
  recordMessageTruthProcessing,
  recordMessageTruthRecovery,
  recordMessageTruthSuppressed,
} from "../../services/intelligenceTruth.js";
import { isDeepAnalysisCandidate } from "../../services/messageTriage.js";
import { sanitizeForExternalUse } from "../../services/privacyFilter.js";
import { computeRiskScore } from "../../services/riskHeuristic.js";
import { buildRoleDirectory } from "../../services/roleInference.js";
import { logger } from "../../utils/logger.js";
import type {
  DominantEmotion,
  EnrichedMessageWithAnalyticsRow,
  EscalationRisk,
  FollowUpSeriousness,
  MessageRow,
} from "../../types/database.js";
import type { LLMAnalyzeJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "llmAnalyze" });

type SnapshotState = {
  totalMessages: number;
  highRiskCount: number;
  updatedAt: string;
  emotionDistribution: Partial<Record<DominantEmotion, number>>;
};

function hasPersistedAnalysis(row: EnrichedMessageWithAnalyticsRow): boolean {
  return row.ma_dominant_emotion !== null;
}

function buildSnapshotState(
  channelState: Awaited<ReturnType<typeof db.getChannelState>>,
): SnapshotState {
  const snapshot = channelState?.sentiment_snapshot_json;
  return {
    totalMessages: snapshot?.totalMessages ?? 0,
    highRiskCount: snapshot?.highRiskCount ?? 0,
    updatedAt: snapshot?.updatedAt ?? "",
    emotionDistribution: {
      anger: snapshot?.emotionDistribution?.anger ?? 0,
      disgust: snapshot?.emotionDistribution?.disgust ?? 0,
      fear: snapshot?.emotionDistribution?.fear ?? 0,
      joy: snapshot?.emotionDistribution?.joy ?? 0,
      neutral: snapshot?.emotionDistribution?.neutral ?? 0,
      sadness: snapshot?.emotionDistribution?.sadness ?? 0,
      surprise: snapshot?.emotionDistribution?.surprise ?? 0,
    },
  };
}

function sortMessagesAsc(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort(
    (a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts),
  );
}

export async function handleLLMAnalyze(
  jobs: Job<LLMAnalyzeJob>[],
): Promise<void> {
  for (const job of jobs) {
    const {
      workspaceId,
      channelId,
      triggerType,
      threadTs,
      targetMessageTs,
      mode = "latest",
      suppressAlerts = false,
    } = job.data;

    log.info(
      { jobId: job.id, channelId, triggerType, threadTs, mode, targetMessageTs },
      "Starting LLM analysis",
    );

    // 1. Fetch messages
    const rule = await db.getFollowUpRule(workspaceId, channelId);
    const analysisWindowDays = resolveAnalysisWindowDays(rule);
    const isThread = !!threadTs;
    const hadExplicitTargets = Array.isArray(targetMessageTs) && targetMessageTs.length > 0;
    const explicitTargetTs = Array.from(new Set(targetMessageTs ?? []))
      .filter((ts) => isTsWithinAnalysisWindow(ts, analysisWindowDays))
      .sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))
      .slice(0, TARGET_MESSAGE_COUNT);

    if (hadExplicitTargets && explicitTargetTs.length === 0) {
      log.info(
        { channelId, threadTs, mode, analysisWindowDays },
        "Skipping manual analysis because requested targets are outside the analysis window",
      );
      continue;
    }

    const contextLimit = explicitTargetTs.length > 0
      ? isThread
        ? 200
        : 60
      : isThread
        ? THREAD_MESSAGE_LIMIT
        : CHANNEL_MESSAGE_LIMIT;
    let messages = await db.getMessages(workspaceId, channelId, {
      limit: contextLimit,
      threadTs: threadTs ?? null,
    });

    if (messages.length === 0) {
      log.warn({ channelId, threadTs }, "No messages found for analysis");
      continue;
    }

    if (explicitTargetTs.length > 0) {
      const knownTs = new Set(messages.map((message) => message.ts));
      const missingTargetTs = explicitTargetTs.filter((ts) => !knownTs.has(ts));
      if (missingTargetTs.length > 0) {
        messages = sortMessagesAsc([
          ...messages,
          ...(await db.getMessagesByTs(workspaceId, channelId, missingTargetTs)),
        ]);
      }
    }
    messages = sortMessagesAsc(
      messages.filter((message) => isTsWithinAnalysisWindow(message.ts, analysisWindowDays)),
    );

    if (messages.length === 0) {
      log.info(
        { channelId, threadTs, mode, analysisWindowDays },
        "No messages found within the configured analysis window",
      );
      continue;
    }

    const requestedTargets = explicitTargetTs.length > 0
      ? explicitTargetTs
      : messages.length > 0
        ? [messages[messages.length - 1].ts]
        : [];
    if (requestedTargets.length === 0) {
      continue;
    }

    const targetRows = await db.getMessagesEnrichedByTs(workspaceId, channelId, requestedTargets);
    const normalizedTargetRows = targetRows
      .filter((message) => isTsWithinAnalysisWindow(message.ts, analysisWindowDays))
      .sort((a, b) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts))
      .slice(0, TARGET_MESSAGE_COUNT);

    if (normalizedTargetRows.length === 0) {
      log.info(
        { channelId, threadTs, mode, analysisWindowDays },
        "No target messages remained after enforcing the analysis window",
      );
      continue;
    }

    const messagesByTs = new Map(messages.map((message) => [message.ts, message]));
    const allowNonCandidateTargets = triggerType === "manual";
    const targetsToAnalyze = normalizedTargetRows.filter(
      (message) =>
        (
          allowNonCandidateTargets ||
          isDeepAnalysisCandidate(message.mt_candidate_kind)
        ) &&
        (!hasPersistedAnalysis(message) || message.analysis_status !== "completed"),
    );

    if (targetsToAnalyze.length === 0) {
      log.info({ channelId, threadTs, mode }, "Requested messages already analyzed");
      continue;
    }

    // 2. Budget check after target resolution so we can stamp a terminal truth state
    // instead of leaving messages stuck in pending/processing recovery loops.
    const dailyCost = await db.getDailyLLMCost(workspaceId);
    if (dailyCost >= config.LLM_DAILY_BUDGET_USD) {
      alertBudgetExceeded(workspaceId, dailyCost, config.LLM_DAILY_BUDGET_USD);
      await recordIntelligenceDegradation({
        workspaceId,
        channelId,
        scope: "channel",
        eventType: "budget_exceeded",
        severity: "high",
        details: {
          jobType: "llm.analyze",
          dailyCost,
          budget: config.LLM_DAILY_BUDGET_USD,
          suppressedTargets: targetsToAnalyze.length,
          mode,
          triggerType,
        },
      });
      for (const target of targetsToAnalyze) {
        const skippedStatus = await recordMessageTruthSuppressed({
          workspaceId,
          channelId,
          messageTs: target.ts,
          eligibilityStatus: "policy_suppressed",
          suppressionReason: "budget_exceeded",
        });
        await db.updateMessageAnalysisStatus(workspaceId, channelId, target.ts, skippedStatus);
      }
      log.warn(
        {
          channelId,
          threadTs,
          mode,
          triggerType,
          dailyCost,
          budget: config.LLM_DAILY_BUDGET_USD,
          suppressedTargets: targetsToAnalyze.length,
        },
        "Budget exceeded, suppressing analysis targets for this run",
      );
      continue;
    }

    // 3. Fetch classification for alert thresholds
    const classification = await db.getChannelClassification(workspaceId, channelId);
    const channelType = classification?.channel_type ?? null;

    const channelState = await db.getChannelState(workspaceId, channelId);
    let snapshotState = buildSnapshotState(channelState);
    const processingTargets = new Set<string>();
    try {
      for (const target of targetsToAnalyze) {
        const targetMessage = messagesByTs.get(target.ts) ?? target;
        const windowMessages = messages
          .filter((message) => Number.parseFloat(message.ts) <= Number.parseFloat(target.ts))
          .slice(-(isThread ? THREAD_MESSAGE_LIMIT : CHANNEL_MESSAGE_LIMIT));
        const sanitizedMessages = windowMessages.map((message) => {
          const rawText = message.normalized_text ?? message.text;
          const sanitized = sanitizeForExternalUse(rawText);
          return {
            userId: message.user_id,
            text:
              sanitized.action === "redacted"
                ? sanitized.text
                : sanitized.action === "skipped"
                  ? ""
                  : rawText,
            ts: message.ts,
            privacySkipped: sanitized.action === "skipped",
          };
        });
        const sanitizedTarget = sanitizedMessages.find((message) => message.ts === target.ts) ?? {
          userId: targetMessage.user_id,
          text: targetMessage.normalized_text ?? targetMessage.text,
          ts: target.ts,
          privacySkipped: false,
        };

        if (sanitizedTarget.privacySkipped) {
          const skippedStatus = await recordMessageTruthSuppressed({
            workspaceId,
            channelId,
            messageTs: target.ts,
            eligibilityStatus: "privacy_suppressed",
            suppressionReason: "privacy_skip",
          });
          await db.updateMessageAnalysisStatus(workspaceId, channelId, target.ts, skippedStatus);
          continue;
        }

        processingTargets.add(target.ts);
        if (hasPersistedAnalysis(target) && target.analysis_status !== "completed") {
          await recordMessageTruthRecovery({
            workspaceId,
            channelId,
            messageTs: target.ts,
            eligibilityStatus: "eligible",
            degradationEventType: "incomplete_persisted_analysis_recovered",
            degradationDetails: {
              triggerType,
              mode,
            },
          });
        } else {
          await recordMessageTruthProcessing({
            workspaceId,
            channelId,
            messageTs: target.ts,
            eligibilityStatus: "eligible",
          });
        }
        await db.updateMessageAnalysisStatus(workspaceId, channelId, target.ts, "processing");

        const contextMsgs = sanitizedMessages.map(({ userId, text, ts }) => ({ userId, text, ts }));
        const assembled = await assembleContext(
          workspaceId,
          channelId,
          sanitizedTarget.text,
          contextMsgs,
        );
        const precedingMessages = contextMsgs.filter((message) => message.ts !== target.ts);
        const riskScore = computeRiskScore(sanitizedTarget.text);
        const result = await analyzeMessage({
          runningSummary: assembled.runningSummary,
          keyDecisions: assembled.keyDecisions,
          relevantDocuments: assembled.relevantDocuments,
          riskScore,
          messageText: sanitizedTarget.text,
          recentMessages: precedingMessages.length > 0 ? precedingMessages : undefined,
        });

        if (result.status === "failed") {
          log.warn({ channelId, messageTs: target.ts, error: result.error }, "Message analysis failed");
          const failedStatus = await recordMessageTruthFailed({
            workspaceId,
            channelId,
            messageTs: target.ts,
            eligibilityStatus: "eligible",
            degradationEventType: "analysis_failed",
            degradationDetails: {
              triggerType,
              mode,
              error: result.error ?? null,
            },
          });
          await db.updateMessageAnalysisStatus(workspaceId, channelId, target.ts, failedStatus);
          processingTargets.delete(target.ts);
          await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
          continue;
        }

        // Validate trigger phrases are exact substrings of the original message text.
        // LLMs sometimes hallucinate phrases that don't appear in the source — drop them.
        const originalText = targetMessage.text ?? "";
        const originalLower = originalText.toLowerCase();
        const rawTriggers = (result.data.trigger_phrases as string[] | undefined) ?? [];
        result.data.trigger_phrases = rawTriggers.filter(
          (phrase: string) => phrase.length > 0 && originalLower.includes(phrase.toLowerCase()),
        );

        const analysisEscalationRisk = result.data.escalation_risk as EscalationRisk;
        const analysisDominantEmotion = result.data.dominant_emotion as DominantEmotion;

        await db.insertMessageAnalytics({
          workspaceId,
          channelId,
          messageTs: target.ts,
          dominantEmotion: analysisDominantEmotion,
          interactionTone: result.data.interaction_tone ?? "neutral",
          confidence: result.data.confidence,
          escalationRisk: analysisEscalationRisk,
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
          messageIntent: result.data.message_intent ?? null,
          isActionable: result.data.is_actionable ?? null,
          isBlocking: result.data.is_blocking ?? false,
          urgencyLevel: result.data.urgency_level ?? "none",
        });

        await recordCost(workspaceId, channelId, result.raw.model, result.raw.promptTokens, result.raw.completionTokens);
        const completedStatus = await recordMessageTruthCompleted({
          workspaceId,
          channelId,
          messageTs: target.ts,
          eligibilityStatus: "eligible",
        });
        await db.updateMessageAnalysisStatus(workspaceId, channelId, target.ts, completedStatus);
        processingTargets.delete(target.ts);

        snapshotState = {
          totalMessages: snapshotState.totalMessages + 1,
          highRiskCount: snapshotState.highRiskCount + (analysisEscalationRisk === "high" ? 1 : 0),
          updatedAt: new Date().toISOString(),
          emotionDistribution: {
            ...snapshotState.emotionDistribution,
            [analysisDominantEmotion]:
              (snapshotState.emotionDistribution[analysisDominantEmotion] ?? 0) + 1,
          },
        };
        await db.upsertChannelState(workspaceId, channelId, {
          sentiment_snapshot_json: snapshotState,
        });

        // Suppress all alert/DM/follow-up side-effects for backfill seed analysis.
        // Analysis results (scores, emotions) are still saved above — only noise is skipped.
        if (!suppressAlerts) {
        const alertContext = {
          workspaceId,
          channelId,
          messageTs: target.ts,
          threadTs: threadTs ?? target.thread_ts ?? undefined,
          channelType,
        };
        checkAndAlert(result.data, alertContext);

        // Fire-and-forget: send Slack DMs for high-severity sentiment alerts
        const isDeteriorating = "sentiment_trajectory" in result.data &&
          result.data.sentiment_trajectory === "deteriorating";
        if (
          analysisEscalationRisk === "high" ||
          (
            analysisDominantEmotion === "anger" &&
            result.data.confidence > 0.85 &&
            result.data.interaction_tone !== "corrective"
          ) ||
          (result.data.sarcasm_detected && result.data.intended_emotion === "anger") ||
          isDeteriorating
        ) {
          const alertType = analysisEscalationRisk === "high"
            ? "high_escalation_risk"
            : isDeteriorating
              ? "deteriorating_sentiment"
              : result.data.sarcasm_detected
                ? "sarcasm_masked_anger"
                : "high_confidence_anger";

          void sendSentimentAlertDMs(alertContext, alertType, {
            explanation: result.data.explanation,
            emotion: analysisDominantEmotion,
            confidence: result.data.confidence,
          });
        }

        // LLM-backed follow-up creation: if the LLM classifies as actionable,
        // ensure a follow-up item exists even if heuristic scoring missed it
        if (
          result.data.is_actionable &&
          result.data.message_intent !== "acknowledgment" &&
          result.data.message_intent !== "fyi"
        ) {
          // ─── Thread-aware check: skip follow-up if the conversation is already resolved ───
          // If someone other than the requester has replied AFTER this message, the
          // question is likely already addressed. Covers scenarios like:
          // - Person A asks question → Person B replies → no follow-up needed
          // - Thread naturally concluded with a response
          const laterMessages = messages.filter(
            (m) => Number.parseFloat(m.ts) > Number.parseFloat(target.ts),
          );
          const hasSubstantiveReply = laterMessages.some((m) => {
            if (m.user_id === target.user_id) return false; // same person, not a resolution
            if (!m.text) return false;
            const trimmed = m.text.trim().toLowerCase();
            // Even short acks from another person count as thread resolution
            if (trimmed.length < 2) return false;
            return true;
          });

          if (hasSubstantiveReply) {
            log.debug(
              { channelId, messageTs: target.ts, user: target.user_id },
              "Skipping follow-up — thread already has a reply from another user",
            );
          }

          // Also skip if the requester themselves acknowledged with a closing message
          // after someone else's reply (e.g., "okay", "thanks", "got it")
          const CLOSING_PATTERNS = /^(ok(ay)?|got\s*it|thanks?|thank\s*you|cool|sure|sounds?\s*good|perfect|great|noted|will\s*do|done|👍|✅|🙏|alright|ack)\b/i;
          const requesterAcked = laterMessages.some((m) => {
            if (m.user_id !== target.user_id) return false;
            return CLOSING_PATTERNS.test(m.text?.trim() ?? "");
          });

          if (hasSubstantiveReply || requesterAcked) {
            // Thread is already handled — don't create a follow-up
            log.debug(
              { channelId, messageTs: target.ts, hasReply: hasSubstantiveReply, requesterAcked },
              "Skipping follow-up — conversation already resolved",
            );
            // Also auto-resolve any existing open follow-up for this message
            const existing = await db.getOpenFollowUpBySourceMessage(workspaceId, channelId, target.ts);
            if (existing) {
              const resolverTs = laterMessages[laterMessages.length - 1]?.ts ?? target.ts;
              await clearFollowUpReminderDms(workspaceId, existing.id);
              await db.resolveFollowUpItem({
                itemId: existing.id,
                resolvedMessageTs: resolverTs,
                resolutionReason: requesterAcked ? "requester_ack" : "reply",
                resolutionScope: threadTs ? "thread" : "channel",
                resolvedByUserId: requesterAcked
                  ? target.user_id
                  : laterMessages[laterMessages.length - 1]?.user_id ?? null,
                lastEngagementAt: new Date(Number.parseFloat(resolverTs) * 1000),
              });
            }
            continue;
          }

          const conversationType = rule?.conversation_type ?? "public_channel";
          const privacyAllowed =
            conversationType === "public_channel" || Boolean(rule?.privacy_opt_in);
          if (!privacyAllowed || rule?.muted || rule?.enabled === false) {
            continue;
          }
          const urgency = result.data.urgency_level ?? "none";
          const contextSlaHours = computeContextSLA({
            senderRole: "unknown",
            conversationType,
            messageIntent: result.data.message_intent ?? null,
            urgencyLevel: urgency,
            configuredSlaHours: rule?.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
          });
          const baseMs = Number.parseFloat(target.ts) * 1000;
          const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
          const dueAt = new Date(startMs + contextSlaHours * 60 * 60 * 1000);
          const visibilityAfter = new Date(
            startMs + config.FOLLOW_UP_REPLY_GRACE_MINUTES * 60 * 1000,
          );

          let seriousness: FollowUpSeriousness = "medium";
          if (urgency === "critical" || urgency === "high") seriousness = "high";
          else if (urgency === "none" || urgency === "low") seriousness = "low";

          const roleDirectory = await buildRoleDirectory(workspaceId);
          const effectiveRoles = new Map(
            roleDirectory.map((entry) => [entry.userId, entry.effectiveRole]),
          );
          const ownership = resolveOwnershipLanes(rule, effectiveRoles, target.user_id);

          const created = await db.createFollowUpItem({
            workspaceId,
            channelId,
            sourceMessageTs: target.ts,
            sourceThreadTs: threadTs ?? target.thread_ts ?? null,
            requesterUserId: target.user_id,
            seriousness,
            seriousnessScore: seriousness === "high" ? 8 : seriousness === "medium" ? 5 : 3,
            detectionMode: "llm",
            reasonCodes: [`intent:${result.data.message_intent}`, "llm_actionable"],
            summary: `LLM detected actionable ${result.data.message_intent ?? "message"} requiring response.`,
            dueAt,
            workflowState: "pending_reply_window",
            primaryResponderIds: ownership.primaryResponderIds,
            escalationResponderIds: ownership.escalationResponderIds,
            visibilityAfter,
            nextExpectedResponseAt: dueAt,
            metadata: {
              llmDetected: true,
              urgencyLevel: urgency,
              primaryResponderIds: ownership.primaryResponderIds,
              escalationResponderIds: ownership.escalationResponderIds,
            },
          });
          await db.recordFollowUpEvent({
            followUpItemId: created.id,
            workspaceId,
            channelId,
            eventType: "created",
            workflowState: "pending_reply_window",
            actorUserId: target.user_id,
            messageTs: target.ts,
            metadata: {
              source: "llm",
            },
          });

          // Only emit alert if this was a genuine new insert (not a conflict update)
          const wasInserted = created.created_at.getTime() === created.updated_at.getTime() ||
            Math.abs(created.created_at.getTime() - created.updated_at.getTime()) < 1000;
          if (wasInserted) {
            log.debug(
              { channelId, messageTs: target.ts, followUpItemId: created.id },
              "Created pending follow-up item from LLM actionable detection",
            );
          }
        }
        } // end if (!suppressAlerts)

        eventBus.createAndPublish("analysis_completed", workspaceId, channelId, {
          messageTs: target.ts,
          escalationRisk: analysisEscalationRisk,
          threadTs: threadTs ?? target.thread_ts ?? null,
        });
      }

      log.info(
        {
          jobId: job.id,
          channelId,
          triggerType,
          processed: targetsToAnalyze.length,
          mode,
        },
        "LLM analysis complete",
      );
      await persistCanonicalChannelState(workspaceId, channelId, {
        rule,
      });
    } catch (err) {
      log.error({ err, channelId, triggerType, mode }, "LLM analysis threw unexpected error");
      for (const targetTs of processingTargets) {
        const failedStatus = await recordMessageTruthFailed({
          workspaceId,
          channelId,
          messageTs: targetTs,
          eligibilityStatus: "eligible",
          degradationEventType: "analysis_threw_unexpected_error",
          degradationDetails: {
            triggerType,
            mode,
          },
        });
        await db.updateMessageAnalysisStatus(workspaceId, channelId, targetTs, failedStatus);
      }
      await persistCanonicalChannelState(workspaceId, channelId, {
        rule,
      });
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
