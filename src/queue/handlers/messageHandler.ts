import { config } from "../../config.js";
import * as db from "../../db/queries.js";
import { persistCanonicalChannelState } from "../../services/canonicalChannelState.js";
import { resolveChannelMode } from "../../services/channelMode.js";
import {
  getThreadRollupThresholdsForTier,
  resolveConversationImportance,
  tierAllowsMomentumThreadRollups,
  tierAllowsRoutineChannelSummary,
  tierAllowsRoutineMessageAnalysis,
} from "../../services/conversationImportance.js";
import { eventBus } from "../../services/eventBus.js";
import { detectFathomLinks } from "../../services/fathomLinkDetector.js";
import { processFollowUpsForMessage } from "../../services/followUpMonitor.js";
import {
  recordMessageTruthState,
  recordMessageTruthSuppressed,
} from "../../services/intelligenceTruth.js";
import { checkIntentContinuation } from "../../services/intentContinuation.js";
import { evaluateLLMGate } from "../../services/llmGate.js";
import { checkMeetingObligationProgress } from "../../services/meetingSlackWatcher.js";
import { classifyMessageTriage, shouldEnrichMessageSignal, shouldRefreshThreadInsight } from "../../services/messageTriage.js";
import { normalizeText, buildFileContext, buildLinkContext, extractLinks } from "../../services/textNormalizer.js";
import { resolveUserProfile } from "../../services/userProfiles.js";
import { logger } from "../../utils/logger.js";
import { enqueueRealtimeLLMAnalyze, enqueueSummaryRollup } from "../boss.js";
import type { MessageIngestJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "messageIngest" });

export async function handleMessageIngest(
  jobs: Job<MessageIngestJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, ts, userId, text, threadTs, subtype, botId, files } = job.data;
    const isAutomatedMessage = typeof botId === "string" && botId.length > 0;

    // Extract link metadata from raw text before normalization
    const extractedLinks = extractLinks(text);

    log.debug({ jobId: job.id, channelId, ts, fileCount: files?.length ?? 0, linkCount: extractedLinks.length }, "Processing message ingest");

    // Store message in database
    const storedMessage = await db.upsertMessage(
      workspaceId,
      channelId,
      ts,
      userId,
      text,
      "realtime",
      threadTs,
      subtype ?? null,
      botId ?? null,
      files && files.length > 0 ? files : null,
      extractedLinks.length > 0 ? extractedLinks : null,
    );

    // Store thread edge if this is a threaded reply
    if (threadTs && ts !== threadTs) {
      await db.upsertThreadEdge(workspaceId, channelId, threadTs, ts);
    }

    // During backfill (channel not yet "ready"), store the message but skip the
    // entire analysis pipeline. The first summary + surfaced artifacts are seeded
    // after backfill completes, which prevents alert/DM/follow-up spam.
    const channel = await db.getChannel(workspaceId, channelId);
    if (channel?.status !== "ready") {
      const finalAnalysisStatus = await recordMessageTruthSuppressed({
        workspaceId,
        channelId,
        messageTs: ts,
        eligibilityStatus: "policy_suppressed",
        suppressionReason: "channel_not_ready",
      });
      await db.updateMessageAnalysisStatus(workspaceId, channelId, ts, finalAnalysisStatus);
      // Keep channel recency fresh even while setup is still catching up.
      await db.updateChannelLastEvent(workspaceId, channelId);
      if (!isAutomatedMessage) {
        resolveUserProfile(workspaceId, userId).catch((err) => {
          const errMsg = err instanceof Error ? err.message : "unknown";
          log.warn({ userId, error: errMsg }, "User profile resolution failed during ingest");
        });
      }
      eventBus.createAndPublish("message_ingested", workspaceId, channelId, {
        ts,
        userId,
        threadTs: threadTs ?? null,
        analysisStatus: finalAnalysisStatus,
      });
      log.debug({ jobId: job.id, channelId, ts, channelStatus: channel?.status }, "Channel not ready — message stored, analysis skipped");
      continue;
    }

    // Resolve user profile (fire-and-forget, cache-first)
    if (!isAutomatedMessage) {
      resolveUserProfile(workspaceId, userId).catch((err) => {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.warn({ userId, error: errMsg }, "User profile resolution failed during ingest");
      });
    }

    // Update channel last event timestamp
    await db.updateChannelLastEvent(workspaceId, channelId);

    // Increment counters
    await db.incrementMessageCounters(workspaceId, channelId);

    const [rule, channelState] = await Promise.all([
      db.getFollowUpRule(workspaceId, channelId),
      db.getChannelState(workspaceId, channelId),
    ]);
    const channelMode = resolveChannelMode({
      channelName: channel?.name ?? channelId,
      conversationType:
        rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
      channelModeOverride: rule?.channel_mode_override,
      botMessageRatio: isAutomatedMessage ? 1 : 0,
      automationSignalRatio: isAutomatedMessage ? 0.75 : 0,
    }).effectiveChannelMode;
    const originType =
      isAutomatedMessage ? "bot" : subtype ? "system" : "human";

    // Text normalization — append file + link context so LLM knows about shared artifacts
    const baseNormalized = normalizeText(text);
    const fileContext = buildFileContext(files);
    const linkContext = buildLinkContext(extractedLinks.length > 0 ? extractedLinks : null);
    const normalizedText = (baseNormalized + fileContext + linkContext).trim();
    await db.updateNormalizedText(workspaceId, channelId, ts, normalizedText);
    const triage = classifyMessageTriage({
      text,
      normalizedText,
      threadTs: threadTs ?? null,
      channelMode,
      originType,
      channelName: channel?.name ?? channelId,
    });
    await db.upsertMessageTriage({
      workspaceId,
      channelId,
      messageTs: ts,
      candidateKind: triage.candidateKind,
      signalType: triage.signalType,
      severity: triage.severity,
      surfacePriority: triage.surfacePriority,
      candidateScore: triage.candidateScore,
      stateTransition: triage.stateTransition,
      stateImpact: triage.stateImpact,
      evidenceType: triage.evidenceType,
      channelMode: triage.channelMode,
      originType: triage.originType,
      confidence: triage.confidence,
      incidentFamily: triage.incidentFamily,
      reasonCodes: triage.reasonCodes,
      signals: triage.signals,
    });

    if (!isAutomatedMessage) {
      await processFollowUpsForMessage({
        workspaceId,
        channelId,
        ts,
        threadTs: threadTs ?? null,
        userId,
        text: normalizedText,
        rawText: text,
      });

      // Check for meeting obligation progress (lightweight, only queries if open obligations exist)
      if (config.FATHOM_ENABLED) {
        await checkMeetingObligationProgress(workspaceId, channelId, normalizedText, userId, ts);
        // Detect Fathom share URLs and auto-link meetings to this channel
        await detectFathomLinks(workspaceId, channelId, text, userId, ts);
      }

      // Intent continuation: auto-resolve follow-ups when someone says "done", "sent it", etc.
      checkIntentContinuation({
        workspaceId,
        channelId,
        messageTs: ts,
        threadTs: threadTs ?? null,
        userId,
        text: normalizedText,
        hasFiles: (files?.length ?? 0) > 0,
      }).catch((err) => {
        log.debug({ err: err instanceof Error ? err.message : "unknown" }, "Intent continuation check failed (non-fatal)");
      });
    }

    // Fetch AI classification (non-blocking — falls back to heuristic if not available)
    const classification = await db.getChannelClassification(workspaceId, channelId);

    const importance = resolveConversationImportance({
      channelName: channel?.name ?? channelId,
      conversationType: rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
      clientUserIds: rule?.client_user_ids ?? [],
      importanceTierOverride: rule?.importance_tier_override,
      channelType: classification?.channel_type ?? null,
      classificationConfidence: classification?.confidence ?? null,
      classificationSource: classification?.classification_source ?? null,
    });
    const importanceTier = importance.effectiveImportanceTier;

    // LLM gate evaluation
    const gateTrigger = channelState
      ? evaluateLLMGate(normalizedText, channelState, threadTs)
      : null;
    const effectiveGateTrigger =
      importanceTier === "low_value" && gateTrigger !== "risk"
        ? null
        : gateTrigger;

    if (gateTrigger && !effectiveGateTrigger) {
      log.info(
        { channelId, ts, threadTs: threadTs ?? null, gateTrigger, importanceTier },
        "Routine message analysis suppressed by importance tier",
      );
    }

    const realtimeJobId = effectiveGateTrigger &&
      (
        tierAllowsRoutineMessageAnalysis(importanceTier) ||
        effectiveGateTrigger === "risk"
      ) &&
      shouldEnrichMessageSignal(triage)
      ? await enqueueRealtimeLLMAnalyze({
        workspaceId,
        channelId,
        triggerType: effectiveGateTrigger,
        mode: "latest",
        threadTs: threadTs ?? null,
      })
      : null;
    let finalAnalysisStatus = storedMessage.analysis_status;
    const eligibleForAnalysis = shouldEnrichMessageSignal(triage);

    if (
      !realtimeJobId &&
      (
        storedMessage.analysis_status === "pending" ||
        storedMessage.analysis_status === "processing" ||
        storedMessage.analysis_status === "failed"
      )
    ) {
      finalAnalysisStatus = await recordMessageTruthState({
        workspaceId,
        channelId,
        messageTs: ts,
        eligibilityStatus: eligibleForAnalysis ? "policy_suppressed" : "not_candidate",
        executionStatus: "not_run",
        qualityStatus: "none",
        suppressionReason: eligibleForAnalysis ? "importance_tier" : "not_candidate",
      });
      await db.updateMessageAnalysisStatus(workspaceId, channelId, ts, finalAnalysisStatus);
    }

    if (realtimeJobId) {
      finalAnalysisStatus = await recordMessageTruthState({
        workspaceId,
        channelId,
        messageTs: ts,
        eligibilityStatus: "eligible",
        executionStatus: "pending",
        qualityStatus: "none",
      });
      await db.updateMessageAnalysisStatus(workspaceId, channelId, ts, finalAnalysisStatus);
    }

    // Preserve cooldown semantics for explicit gate-based triggers.
    if (effectiveGateTrigger && channelState && realtimeJobId) {
      await db.resetLLMGatingState(workspaceId, channelId, config.LLM_COOLDOWN_SEC);
    }

    // Rollup trigger evaluation
    if (channelState) {
      const shouldChannelRollup =
        channelState.messages_since_last_rollup >= config.ROLLUP_MSG_THRESHOLD ||
        (channelState.messages_since_last_rollup > 0 &&
          channelState.last_rollup_at !== null &&
          Date.now() - new Date(channelState.last_rollup_at).getTime() >=
            config.ROLLUP_TIME_THRESHOLD_MIN * 60_000);

      if (shouldChannelRollup && tierAllowsRoutineChannelSummary(importanceTier)) {
        await enqueueSummaryRollup({
          workspaceId,
          channelId,
          rollupType: "channel",
          requestedBy: "message_ingest",
        });
      } else if (shouldChannelRollup && !tierAllowsRoutineChannelSummary(importanceTier)) {
        log.info(
          { channelId, ts, importanceTier },
          "Routine channel rollup suppressed by importance tier",
        );
      }

      // Thread rollup: check if threaded reply count exceeds threshold
      if (threadTs) {
        const rollupThresholds = getThreadRollupThresholdsForTier(importanceTier, {
          replyThreshold: config.ROLLUP_THREAD_REPLY_THRESHOLD,
          hotReplyThreshold: config.THREAD_HOT_REPLY_THRESHOLD,
        });
        const [replyCount, recentReplyCount] = await Promise.all([
          db.getThreadReplyCount(workspaceId, channelId, threadTs),
          db.getRecentThreadReplyCount(
            workspaceId,
            channelId,
            threadTs,
            config.THREAD_HOT_WINDOW_MIN,
          ),
        ]);
        const isHotThread =
          tierAllowsMomentumThreadRollups(importanceTier) &&
          recentReplyCount >= rollupThresholds.hotReplyThreshold;
        const signalDrivenRefresh = shouldRefreshThreadInsight(triage, threadTs);
        if (
          (
            tierAllowsMomentumThreadRollups(importanceTier) &&
            replyCount >= rollupThresholds.replyThreshold
          ) ||
          isHotThread ||
          signalDrivenRefresh
        ) {
          await enqueueSummaryRollup({
            workspaceId,
            channelId,
            rollupType: "thread",
            threadTs,
            requestedBy: "message_ingest",
          });
        } else if (
          !tierAllowsMomentumThreadRollups(importanceTier) &&
          (replyCount >= rollupThresholds.replyThreshold || recentReplyCount >= rollupThresholds.hotReplyThreshold)
        ) {
          log.info(
            { channelId, threadTs, ts, importanceTier, replyCount, recentReplyCount },
            "Momentum-driven thread rollup suppressed by importance tier",
          );
        }
      }
    }

    await persistCanonicalChannelState(workspaceId, channelId, {
      channel,
      rule,
      channelState,
    });

    // Emit real-time event so the frontend dashboard updates immediately
    eventBus.createAndPublish("message_ingested", workspaceId, channelId, {
      ts,
      userId,
      threadTs: threadTs ?? null,
      analysisStatus: finalAnalysisStatus,
    });

    log.debug({ jobId: job.id, channelId, ts }, "Message ingest complete");
  }
}
