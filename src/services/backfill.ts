import { config } from "../config.js";
import * as db from "../db/queries.js";
import {
  enqueueBackfillTier2,
  enqueueBackfillTier3,
  enqueueSummaryRollup,
} from "../queue/boss.js";
import { isIngestibleHistoryMessage } from "../types/slack.js";
import { logger } from "../utils/logger.js";
import { materializeBackfillSummary } from "./backfillSummary.js";
import { persistCanonicalChannelState } from "./canonicalChannelState.js";
import { persistCanonicalMessageSignal } from "./canonicalMessageSignals.js";
import { allowsAutomatedMessageIngestion } from "./channelMessagePolicy.js";
import { resolveChannelMetadata } from "./channelMetadata.js";
import {
  getRiskOnlyMonitoringNotice,
  resolveConversationImportance,
  tierAllowsRoutineChannelSummary,
  tierAllowsThreadBootstrap,
} from "./conversationImportance.js";
import {
  insertContextDocumentWithArtifact,
  completeBackfillRun,
  failBackfillRun,
  recordIntelligenceDegradation,
  recordMessageTruthSuppressed,
  recordSummaryArtifact,
  startBackfillRun,
  updateBackfillRun,
} from "./intelligenceTruth.js";
import { getSlackClient } from "./slackClientFactory.js";
import {
  extractSlackMessageText,
  mapSlackFiles,
} from "./slackMessageContent.js";
import { buildFallbackChannelSummary } from "./summaryState.js";
import { extractLinks } from "./textNormalizer.js";
import { batchResolveUsers } from "./userProfiles.js";

const log = logger.child({ service: "backfill" });

async function syncChannelMetadata(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const [existing, metadata] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    resolveChannelMetadata(workspaceId, channelId),
  ]);

  if (!metadata) {
    return;
  }

  await db.upsertChannel(
    workspaceId,
    channelId,
    existing?.status ?? "pending",
    metadata.name ?? existing?.name ?? null,
    metadata.conversationType,
  );
}

export async function syncChannelMemberList(
  workspaceId: string,
  channelId: string,
): Promise<{ memberCount: number; degraded: boolean }> {
  try {
    const slack = await getSlackClient(workspaceId);
    const allMembers: string[] = [];
    let cursor: string | undefined;
    do {
      const resp = await slack.fetchChannelMembers(channelId, cursor);
      if (resp.members) allMembers.push(...resp.members);
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);

    if (allMembers.length === 0) {
      log.info({ channelId }, "No members returned from conversations.members");
      return { memberCount: 0, degraded: false };
    }

    await db.syncChannelMembers(workspaceId, channelId, allMembers);

    // Resolve profiles for any new members not yet in user_profiles
    const existingProfiles = await db.getUserProfiles(workspaceId, allMembers);
    const existingIds = new Set(existingProfiles.map((p) => p.user_id));
    const newIds = allMembers.filter((id) => !existingIds.has(id));
    if (newIds.length > 0) {
      await batchResolveUsers(workspaceId, newIds, 5);
    }

    log.info(
      { channelId, memberCount: allMembers.length, newProfiles: newIds.length },
      "Channel member list synced",
    );
    return { memberCount: allMembers.length, degraded: false };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn({ channelId, err }, "Unable to sync channel member list");
    await recordIntelligenceDegradation({
      workspaceId,
      channelId,
      scope: "backfill",
      eventType: "member_sync_failed",
      severity: "medium",
      details: {
        error: errMsg,
      },
    });
    return { memberCount: 0, degraded: true };
  }
}

async function seedInitialArtifacts(
  workspaceId: string,
  channelId: string,
): Promise<{ seededThreadCount: number; importanceTier: string }> {
  const lookbackHours =
    (await db.getEffectiveAnalysisWindowDays(workspaceId, channelId)) * 24;
  const [channel, rule, activeThreads] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
    db.getActiveThreads(workspaceId, channelId, lookbackHours),
  ]);
  const importance = resolveConversationImportance({
    channelName: channel?.name ?? channelId,
    conversationType:
      rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
    clientUserIds: rule?.client_user_ids ?? [],
    importanceTierOverride: rule?.importance_tier_override,
  });

  if (!tierAllowsThreadBootstrap(importance.effectiveImportanceTier)) {
    return {
      seededThreadCount: 0,
      importanceTier: importance.effectiveImportanceTier,
    };
  }

  const threadLimit =
    importance.effectiveImportanceTier === "high_value" ? 5 : 3;
  let seededThreadCount = 0;

  for (const thread of activeThreads.slice(0, threadLimit)) {
    const jobId = await enqueueSummaryRollup({
      workspaceId,
      channelId,
      rollupType: "thread",
      threadTs: thread.thread_ts,
      requestedBy: "backfill",
    });

    if (jobId) {
      seededThreadCount += 1;
    }
  }

  return {
    seededThreadCount,
    importanceTier: importance.effectiveImportanceTier,
  };
}

export async function runBackfill(
  workspaceId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  log.info(
    { channelId, reason, days: config.BACKFILL_DAYS },
    "Backfill started",
  );

  await syncChannelMetadata(workspaceId, channelId);
  await db.updateChannelStatus(workspaceId, channelId, "initializing");
  const { backfillRunId } = await startBackfillRun({
    workspaceId,
    channelId,
    reason,
  });
  const [channelRecord, rule] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(
    channelRecord?.name,
  );

  const oldest = String(
    Math.floor(Date.now() / 1000) - config.BACKFILL_DAYS * 24 * 60 * 60,
  );

  let cursor: string | undefined;
  let pageCount = 0;
  let messageCount = 0;
  const threadRoots = new Set<string>();
  let threadFetchFailures = 0;
  let memberSyncDegraded: boolean;
  let materializedSummaryArtifactId: string | null;
  let materializedIntelligenceReadiness:
    | "missing"
    | "partial"
    | "ready"
    | "stale";
  let hasDegradations = false;

  try {
    const slack = await getSlackClient(workspaceId);
    // Phase 1: Fetch channel history
    while (pageCount < config.BACKFILL_MAX_PAGES) {
      pageCount += 1;
      const history = await slack.fetchChannelHistory(
        channelId,
        oldest,
        cursor,
      );
      const messages = Array.isArray(history.messages) ? history.messages : [];

      for (const message of messages) {
        if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
          const files = mapSlackFiles(message.files);
          const extractedText = extractSlackMessageText(message);
          const links = extractLinks(extractedText);
          const storedMessage = await db.upsertMessage(
            workspaceId,
            channelId,
            message.ts,
            message.user ?? "",
            extractedText,
            "backfill",
            message.thread_ts,
            message.subtype,
            message.bot_id,
            files,
            links.length > 0 ? links : null,
          );
          await persistCanonicalMessageSignal({
            workspaceId,
            channelId,
            message: storedMessage,
            channel: channelRecord,
            rule,
          });
          await recordMessageTruthSuppressed({
            workspaceId,
            channelId,
            messageTs: message.ts,
            eligibilityStatus: "policy_suppressed",
            suppressionReason: "channel_not_ready",
          });
          messageCount++;
        }

        // Track threads that need reply fetching
        if (typeof message.ts === "string" && (message.reply_count ?? 0) > 0) {
          threadRoots.add(message.ts);
        }
      }

      cursor = history.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    log.info(
      { channelId, messageCount, threads: threadRoots.size, pages: pageCount },
      "Channel history fetched",
    );
    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "history_import",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
    });

    // Phase 2: Fetch thread replies
    for (const rootTs of threadRoots) {
      try {
        log.info({ channelId, threadTs: rootTs }, "Fetching thread replies");
        await fetchAndStoreThread(
          workspaceId,
          channelId,
          rootTs,
          allowAutomatedMessages,
          channelRecord,
          rule,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.warn(
          { channelId, threadTs: rootTs, error: errMsg },
          "Thread fetch failed, skipping",
        );
        threadFetchFailures += 1;
        hasDegradations = true;
        await recordIntelligenceDegradation({
          workspaceId,
          channelId,
          scope: "thread",
          eventType: "thread_fetch_failed",
          severity: "medium",
          threadTs: rootTs,
          details: {
            error: errMsg,
          },
        });
      }
    }
    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "thread_expansion",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
    });

    // Phase 2.5: Batch resolve user profiles
    const userIds = await db.getDistinctUserIds(workspaceId, channelId);
    log.info(
      { channelId, uniqueUsers: userIds.length },
      "Resolving user profiles",
    );
    await batchResolveUsers(workspaceId, userIds, 5);
    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "user_enrichment",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
      usersResolved: userIds.length,
    });

    // Phase 2.75: Fetch channel member list from Slack
    const memberSync = await syncChannelMemberList(workspaceId, channelId);
    memberSyncDegraded = memberSync.degraded;
    hasDegradations ||= memberSync.degraded;
    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "member_sync",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
      usersResolved: userIds.length,
      memberSyncResult: memberSync.degraded ? "degraded" : "succeeded",
    });

    // Phase 3: Build derived state
    await refreshChannelState(workspaceId, channelId);

    const [channel, latestRule, analysisWindowDays] = await Promise.all([
      db.getChannel(workspaceId, channelId),
      db.getFollowUpRule(workspaceId, channelId),
      db.getEffectiveAnalysisWindowDays(workspaceId, channelId),
    ]);
    const importance = resolveConversationImportance({
      channelName: channel?.name ?? channelId,
      conversationType:
        latestRule?.conversation_type ??
        channel?.conversation_type ??
        "public_channel",
      clientUserIds: latestRule?.client_user_ids ?? [],
      importanceTierOverride: latestRule?.importance_tier_override,
    });
    const totalMessages = await db.getMessageCount(workspaceId, channelId);

    // Phase 4: Materialize the first trustworthy intelligence artifact before
    // declaring the channel ready. Low-signal channels get an explicit
    // risk-only notice instead of a routine narrative summary.
    if (totalMessages === 0) {
      const artifact = await materializeBackfillSummary({
        workspaceId,
        channelId,
        windowDays: analysisWindowDays,
        publishEvent: true,
      });
      materializedSummaryArtifactId = artifact.summaryArtifactId;
      materializedIntelligenceReadiness =
        artifact.completenessStatus === "no_recent_messages"
          ? "missing"
          : artifact.completenessStatus === "partial"
            ? "partial"
            : artifact.completenessStatus === "stale"
              ? "stale"
              : "ready";
      hasDegradations ||=
        artifact.completenessStatus === "partial" ||
        artifact.degradedReasons.length > 0;
    } else if (
      tierAllowsRoutineChannelSummary(importance.effectiveImportanceTier)
    ) {
      const artifact = await materializeBackfillSummary({
        workspaceId,
        channelId,
        windowDays: analysisWindowDays,
        publishEvent: true,
      });
      materializedSummaryArtifactId = artifact.summaryArtifactId;
      materializedIntelligenceReadiness =
        artifact.completenessStatus === "partial"
          ? "partial"
          : artifact.completenessStatus === "stale"
            ? "stale"
            : artifact.completenessStatus === "no_recent_messages"
              ? "missing"
              : "ready";
      hasDegradations ||=
        artifact.completenessStatus === "partial" ||
        artifact.degradedReasons.length > 0;
    } else {
      const summary = getRiskOnlyMonitoringNotice();
      const artifact = await recordSummaryArtifact({
        workspaceId,
        channelId,
        kind: "backfill_rollup",
        generationMode: "fallback",
        completenessStatus: "partial",
        content: summary,
        keyDecisions: [],
        summaryFacts: [],
        coverageStartTs: null,
        coverageEndTs: null,
        candidateMessageCount: totalMessages,
        includedMessageCount: totalMessages,
        degradedReasons: ["low_signal_channel"],
        updateChannelTruth: true,
      });
      await recordIntelligenceDegradation({
        workspaceId,
        channelId,
        scope: "summary",
        eventType: "low_signal_channel",
        severity: "low",
        details: {
          summaryKind: "backfill_rollup",
        },
      });
      await insertContextDocumentWithArtifact({
        workspaceId,
        channelId,
        docType: "backfill_rollup",
        content: summary,
        tokenCount: Math.ceil(summary.length / 4),
        embedding: null,
        sourceTsStart: null,
        sourceTsEnd: null,
        sourceThreadTs: null,
        messageCount: totalMessages,
        summaryArtifactId: artifact.summaryArtifactId,
      });
      await db.upsertChannelState(workspaceId, channelId, {
        running_summary: summary,
        key_decisions_json: [],
      });
      materializedSummaryArtifactId = artifact.summaryArtifactId;
      materializedIntelligenceReadiness = "partial";
      hasDegradations = true;
    }
    await persistCanonicalChannelState(workspaceId, channelId, {
      channel,
      rule: latestRule,
    });

    const skippedBackfillMessages = await db.markChannelBackfillMessagesSkipped(
      workspaceId,
      channelId,
    );
    if (skippedBackfillMessages > 0) {
      log.info(
        { channelId, skippedBackfillMessages },
        "Normalized historical backfill messages to skipped after bootstrap",
      );
    }

    await db.updateChannelStatus(workspaceId, channelId, "ready");

    // Recovery: re-queue messages that were suppressed during backfill
    // because the channel wasn't ready yet. Now that it IS ready, these
    // messages should be eligible for deep AI analysis.
    try {
      const suppressed = await db.getSuppressedMessagesInReadyChannels(
        channelId,
        500,
      );
      if (suppressed.length > 0) {
        const timestamps = suppressed.map((s) => s.message_ts);
        const recovered = await db.markSuppressedMessagesRecovered(
          workspaceId,
          channelId,
          timestamps,
        );
        log.info(
          { channelId, suppressedFound: suppressed.length, recovered },
          "Recovered suppressed messages after channel became ready",
        );
      }
    } catch (recoveryErr) {
      log.warn(
        {
          channelId,
          err: recoveryErr instanceof Error ? recoveryErr.message : "unknown",
        },
        "Non-fatal: failed to recover suppressed messages after backfill",
      );
    }

    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "initial_intelligence",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
      usersResolved: userIds.length,
      memberSyncResult: memberSyncDegraded ? "degraded" : "succeeded",
      summaryArtifactId: materializedSummaryArtifactId,
      status: hasDegradations ? "completed_with_degradations" : "completed",
    });
    await completeBackfillRun(workspaceId, channelId, backfillRunId, {
      status: hasDegradations ? "completed_with_degradations" : "completed",
      summaryArtifactId: materializedSummaryArtifactId,
      intelligenceReadiness: materializedIntelligenceReadiness,
    });
    let seeded: Awaited<ReturnType<typeof seedInitialArtifacts>> = {
      seededThreadCount: 0,
      importanceTier: importance.effectiveImportanceTier,
    };

    try {
      seeded = await seedInitialArtifacts(workspaceId, channelId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { channelId, error: errMsg },
        "Initial artifact seeding failed after backfill completion",
      );
    }

    log.info(
      {
        channelId,
        totalMessages,
        importanceTier: importance.effectiveImportanceTier,
        seededThreadCount: seeded.seededThreadCount,
      },
      "Backfill complete",
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown_error";
    log.error({ channelId, error: errMsg }, "Backfill failed");
    await db.updateChannelStatus(workspaceId, channelId, "failed");
    await failBackfillRun(workspaceId, channelId, backfillRunId);
    throw error;
  }
}

async function fetchAndStoreThread(
  workspaceId: string,
  channelId: string,
  threadTs: string,
  allowAutomatedMessages = false,
  channel?: Awaited<ReturnType<typeof db.getChannel>> | null,
  rule?: Awaited<ReturnType<typeof db.getFollowUpRule>> | null,
): Promise<void> {
  const slack = await getSlackClient(workspaceId);
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < config.BACKFILL_MAX_PAGES) {
    pageCount += 1;
    const response = await slack.fetchThreadReplies(
      channelId,
      threadTs,
      cursor,
    );
    const messages = Array.isArray(response.messages) ? response.messages : [];

    for (const message of messages) {
      if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
        const threadFiles = mapSlackFiles(message.files);
        const extractedText = extractSlackMessageText(message);
        const threadLinks = extractLinks(extractedText);
        const storedMessage = await db.upsertMessage(
          workspaceId,
          channelId,
          message.ts,
          message.user ?? "",
          extractedText,
          "backfill",
          message.thread_ts ?? threadTs,
          message.subtype,
          message.bot_id,
          threadFiles,
          threadLinks.length > 0 ? threadLinks : null,
        );
        await persistCanonicalMessageSignal({
          workspaceId,
          channelId,
          message: storedMessage,
          channel,
          rule,
        });

        // Store thread edge
        if (message.ts !== threadTs) {
          await db.upsertThreadEdge(
            workspaceId,
            channelId,
            threadTs,
            message.ts,
          );
        }
      }
    }

    cursor = response.response_metadata?.next_cursor;
    if (!cursor) break;
  }
}

async function refreshChannelState(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const [messages, threads, totalMessages, participantCounts] =
    await Promise.all([
      db.getMessages(workspaceId, channelId, { limit: 200 }),
      db.getThreads(workspaceId, channelId),
      db.getMessageCount(workspaceId, channelId),
      db.getChannelParticipantCounts(workspaceId, channelId),
    ]);

  // Build participants map
  const participants: Record<string, number> = {};
  for (const participant of participantCounts) {
    participants[participant.user_id] = participant.message_count;
  }

  // Enrich with display names
  const userProfiles = await db.getUserProfiles(
    workspaceId,
    Object.keys(participants),
  );
  const profileMap = new Map(userProfiles.map((p) => [p.user_id, p]));

  // Build summary
  const topParticipants = Object.entries(participants)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([userId, count]) => {
      const profile = profileMap.get(userId);
      const name = profile?.display_name || profile?.real_name || userId;
      return `${name}:${count}`;
    });

  const recentSnippets = messages
    .slice(-5)
    .map((m) => m.text.slice(0, 100))
    .filter(Boolean);

  const runningSummary = buildFallbackChannelSummary({
    totalMessages,
    participantCount: participantCounts.length,
    topParticipants,
    threadCount: threads.length,
    recentSnippets,
  });

  await db.upsertChannelState(workspaceId, channelId, {
    running_summary: runningSummary,
    participants_json: participants,
    active_threads_json: threads.map((t) => ({
      threadTs: t.thread_ts,
      messageCount: t.reply_count,
      lastActivityAt: t.last_activity,
    })),
    sentiment_snapshot_json: {
      totalMessages,
      highRiskCount: 0,
      updatedAt: new Date().toISOString(),
      emotionDistribution: {
        anger: 0,
        disgust: 0,
        fear: 0,
        joy: 0,
        neutral: 0,
        sadness: 0,
        surprise: 0,
      },
    },
  });
}

// ─── Tiered Backfill ────────────────────────────────────────────────────────

/**
 * Tier 1 — Bootstrap (<5 seconds).
 * Syncs metadata + members, marks channel ready immediately, then chains to Tier 2.
 */
export async function runBackfillTier1(
  workspaceId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  log.info({ channelId, reason }, "Tier 1 backfill started");

  await syncChannelMetadata(workspaceId, channelId);
  await syncChannelMemberList(workspaceId, channelId);
  await db.updateChannelStatus(workspaceId, channelId, "ready");
  await db.upsertChannelState(workspaceId, channelId, {
    intelligence_readiness: "bootstrap",
  });
  await db.updateBackfillTier(workspaceId, channelId, 1);

  const { backfillRunId } = await startBackfillRun({
    workspaceId,
    channelId,
    reason,
  });

  await enqueueBackfillTier2(workspaceId, channelId, backfillRunId, reason);

  log.info(
    { channelId, backfillRunId },
    "Tier 1 complete — channel ready with bootstrap intelligence",
  );
}

/**
 * Tier 2 — Recent history (<30 seconds).
 * Fetches last 24 hours of messages, builds a quick summary, then chains to Tier 3.
 */
export async function runBackfillTier2(
  workspaceId: string,
  channelId: string,
  backfillRunId: string,
  reason: string,
): Promise<void> {
  log.info({ channelId, backfillRunId }, "Tier 2 backfill started");

  const slack = await getSlackClient(workspaceId);
  const oldest = String(Math.floor(Date.now() / 1000) - 24 * 60 * 60);

  const [channelRecord, rule] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(
    channelRecord?.name,
  );

  let cursor: string | undefined;
  let pageCount = 0;
  let messageCount = 0;
  let oldestFetchedTs: string | null = null;
  const maxPages = 3;

  while (pageCount < maxPages) {
    pageCount += 1;
    const history = await slack.fetchChannelHistory(channelId, oldest, cursor);
    const messages = Array.isArray(history.messages) ? history.messages : [];

    for (const message of messages) {
      if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
        const files = mapSlackFiles(message.files);
        const extractedText = extractSlackMessageText(message);
        const links = extractLinks(extractedText);
        const storedMessage = await db.upsertMessage(
          workspaceId,
          channelId,
          message.ts,
          message.user ?? "",
          extractedText,
          "backfill",
          message.thread_ts,
          message.subtype,
          message.bot_id,
          files,
          links.length > 0 ? links : null,
        );
        await persistCanonicalMessageSignal({
          workspaceId,
          channelId,
          message: storedMessage,
          channel: channelRecord,
          rule,
        });
        messageCount++;

        // Track the oldest ts we actually stored
        if (!oldestFetchedTs || message.ts < oldestFetchedTs) {
          oldestFetchedTs = message.ts;
        }
      }
    }

    cursor = history.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  log.info(
    { channelId, messageCount, pages: pageCount, oldestFetchedTs },
    "Tier 2 history fetched",
  );

  await refreshChannelState(workspaceId, channelId);

  // Try to materialize a quick summary
  try {
    await materializeBackfillSummary({
      workspaceId,
      channelId,
      publishEvent: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn(
      { channelId, error: errMsg },
      "Tier 2 quick summary materialization failed, continuing",
    );
  }

  await db.upsertChannelState(workspaceId, channelId, {
    intelligence_readiness: "partial",
  });
  await db.updateBackfillTier(workspaceId, channelId, 2, oldestFetchedTs);

  await enqueueBackfillTier3(
    workspaceId,
    channelId,
    backfillRunId,
    reason,
    oldestFetchedTs,
  );

  log.info(
    { channelId, backfillRunId, messageCount, oldestFetchedTs },
    "Tier 2 complete — channel has recent intelligence",
  );
}

/**
 * Tier 3 — Deep backfill (minutes).
 * Fetches from 30 days ago up to the Tier 2 coverage boundary,
 * does thread expansion, user enrichment, full summarization, and artifact seeding.
 */
export async function runBackfillTier3(
  workspaceId: string,
  channelId: string,
  backfillRunId: string,
  reason: string,
  tier2CoverageOldestTs: string | null,
): Promise<void> {
  log.info(
    { channelId, backfillRunId, reason, tier2CoverageOldestTs },
    "Tier 3 backfill started",
  );

  const [channelRecord, rule] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(
    channelRecord?.name,
  );

  const oldest = String(
    Math.floor(Date.now() / 1000) - config.BACKFILL_DAYS * 24 * 60 * 60,
  );

  let cursor: string | undefined;
  let pageCount = 0;
  let messageCount = 0;
  const threadRoots = new Set<string>();
  let threadFetchFailures = 0;
  let hasDegradations = false;

  try {
    const slack = await getSlackClient(workspaceId);

    // Phase 1: Fetch channel history from 30d ago, skipping messages already covered by T2
    while (pageCount < config.BACKFILL_MAX_PAGES) {
      pageCount += 1;
      const history = await slack.fetchChannelHistory(
        channelId,
        oldest,
        cursor,
      );
      const messages = Array.isArray(history.messages) ? history.messages : [];

      for (const message of messages) {
        // Skip messages already covered by Tier 2
        if (
          tier2CoverageOldestTs &&
          typeof message.ts === "string" &&
          message.ts >= tier2CoverageOldestTs
        ) {
          continue;
        }

        if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
          const files = mapSlackFiles(message.files);
          const extractedText = extractSlackMessageText(message);
          const links = extractLinks(extractedText);
          const storedMessage = await db.upsertMessage(
            workspaceId,
            channelId,
            message.ts,
            message.user ?? "",
            extractedText,
            "backfill",
            message.thread_ts,
            message.subtype,
            message.bot_id,
            files,
            links.length > 0 ? links : null,
          );
          await persistCanonicalMessageSignal({
            workspaceId,
            channelId,
            message: storedMessage,
            channel: channelRecord,
            rule,
          });
          await recordMessageTruthSuppressed({
            workspaceId,
            channelId,
            messageTs: message.ts,
            eligibilityStatus: "policy_suppressed",
            suppressionReason: "channel_not_ready",
          });
          messageCount++;
        }

        if (typeof message.ts === "string" && (message.reply_count ?? 0) > 0) {
          threadRoots.add(message.ts);
        }
      }

      cursor = history.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    log.info(
      { channelId, messageCount, threads: threadRoots.size, pages: pageCount },
      "Tier 3 history fetched",
    );

    await updateBackfillRun({
      workspaceId,
      channelId,
      runId: backfillRunId,
      phase: "history_import",
      pagesFetched: pageCount,
      messagesImported: messageCount,
      threadRootsDiscovered: threadRoots.size,
      threadsAttempted: threadRoots.size,
      threadsFailed: threadFetchFailures,
    });

    // Phase 2: Thread expansion
    for (const rootTs of threadRoots) {
      try {
        await fetchAndStoreThread(
          workspaceId,
          channelId,
          rootTs,
          allowAutomatedMessages,
          channelRecord,
          rule,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.warn(
          { channelId, threadTs: rootTs, error: errMsg },
          "Tier 3 thread fetch failed, skipping",
        );
        threadFetchFailures += 1;
        hasDegradations = true;
        await recordIntelligenceDegradation({
          workspaceId,
          channelId,
          scope: "thread",
          eventType: "thread_fetch_failed",
          severity: "medium",
          threadTs: rootTs,
          details: { error: errMsg },
        });
      }
    }

    // Phase 2.5: User enrichment
    const userIds = await db.getDistinctUserIds(workspaceId, channelId);
    await batchResolveUsers(workspaceId, userIds, 5);

    // Phase 3: Full summarization
    await refreshChannelState(workspaceId, channelId);

    const analysisWindowDays = await db.getEffectiveAnalysisWindowDays(
      workspaceId,
      channelId,
    );
    const importance = resolveConversationImportance({
      channelName: channelRecord?.name ?? channelId,
      conversationType:
        rule?.conversation_type ??
        channelRecord?.conversation_type ??
        "public_channel",
      clientUserIds: rule?.client_user_ids ?? [],
      importanceTierOverride: rule?.importance_tier_override,
    });

    if (tierAllowsRoutineChannelSummary(importance.effectiveImportanceTier)) {
      try {
        await materializeBackfillSummary({
          workspaceId,
          channelId,
          windowDays: analysisWindowDays,
          publishEvent: true,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.warn(
          { channelId, error: errMsg },
          "Tier 3 summary materialization failed",
        );
        hasDegradations = true;
      }
    }

    await persistCanonicalChannelState(workspaceId, channelId, {
      channel: channelRecord,
      rule,
    });

    // Mark full intelligence ready
    await db.upsertChannelState(workspaceId, channelId, {
      intelligence_readiness: "ready",
    });
    await db.updateBackfillTier(workspaceId, channelId, null);

    // Recovery: re-queue suppressed messages
    try {
      const suppressed = await db.getSuppressedMessagesInReadyChannels(
        channelId,
        500,
      );
      if (suppressed.length > 0) {
        const timestamps = suppressed.map((s) => s.message_ts);
        const recovered = await db.markSuppressedMessagesRecovered(
          workspaceId,
          channelId,
          timestamps,
        );
        log.info(
          { channelId, suppressedFound: suppressed.length, recovered },
          "Tier 3: recovered suppressed messages",
        );
      }
    } catch (recoveryErr) {
      log.warn(
        {
          channelId,
          err:
            recoveryErr instanceof Error ? recoveryErr.message : "unknown",
        },
        "Non-fatal: failed to recover suppressed messages in tier 3",
      );
    }

    // Seed initial artifacts
    try {
      await seedInitialArtifacts(workspaceId, channelId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { channelId, error: errMsg },
        "Tier 3 artifact seeding failed",
      );
    }

    // Complete the backfill run
    await completeBackfillRun(workspaceId, channelId, backfillRunId, {
      status: hasDegradations ? "completed_with_degradations" : "completed",
      summaryArtifactId: null,
      intelligenceReadiness: "ready",
    });

    log.info(
      { channelId, backfillRunId, messageCount },
      "Tier 3 complete — full intelligence ready",
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "unknown_error";
    log.error({ channelId, error: errMsg }, "Tier 3 backfill failed");
    await failBackfillRun(workspaceId, channelId, backfillRunId);
    throw error;
  }
}
