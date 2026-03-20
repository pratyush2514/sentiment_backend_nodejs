import { config } from "../config.js";
import * as db from "../db/queries.js";
import { enqueueSummaryRollup } from "../queue/boss.js";
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
import { getSlackClient } from "./slackClientFactory.js";
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
): Promise<void> {
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
      return;
    }

    await db.syncChannelMembers(workspaceId, channelId, allMembers);

    // Resolve profiles for any new members not yet in user_profiles
    const existingProfiles = await db.getUserProfiles(workspaceId, allMembers);
    const existingIds = new Set(existingProfiles.map((p) => p.user_id));
    const newIds = allMembers.filter((id) => !existingIds.has(id));
    if (newIds.length > 0) {
      await batchResolveUsers(workspaceId, newIds, 5);
    }

    log.info({ channelId, memberCount: allMembers.length, newProfiles: newIds.length }, "Channel member list synced");
  } catch (err) {
    log.warn({ channelId, err }, "Unable to sync channel member list");
  }
}

async function seedInitialArtifacts(
  workspaceId: string,
  channelId: string,
): Promise<{ seededThreadCount: number; importanceTier: string }> {
  const lookbackHours = (await db.getEffectiveAnalysisWindowDays(workspaceId, channelId)) * 24;
  const [channel, rule, activeThreads] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
    db.getActiveThreads(
      workspaceId,
      channelId,
      lookbackHours,
    ),
  ]);
  const importance = resolveConversationImportance({
    channelName: channel?.name ?? channelId,
    conversationType: rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
    clientUserIds: rule?.client_user_ids ?? [],
    importanceTierOverride: rule?.importance_tier_override,
  });

  if (!tierAllowsThreadBootstrap(importance.effectiveImportanceTier)) {
    return {
      seededThreadCount: 0,
      importanceTier: importance.effectiveImportanceTier,
    };
  }

  const threadLimit = importance.effectiveImportanceTier === "high_value" ? 5 : 3;
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
  log.info({ channelId, reason, days: config.BACKFILL_DAYS }, "Backfill started");

  await syncChannelMetadata(workspaceId, channelId);
  await db.updateChannelStatus(workspaceId, channelId, "initializing");
  const [channelRecord, rule] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(channelRecord?.name);

  const oldest = String(
    Math.floor(Date.now() / 1000) - config.BACKFILL_DAYS * 24 * 60 * 60,
  );

  let cursor: string | undefined;
  let pageCount = 0;
  let messageCount = 0;
  const threadRoots = new Set<string>();

  try {
    const slack = await getSlackClient(workspaceId);
    // Phase 1: Fetch channel history
    while (pageCount < config.BACKFILL_MAX_PAGES) {
      pageCount += 1;
      const history = await slack.fetchChannelHistory(channelId, oldest, cursor);
      const messages = Array.isArray(history.messages) ? history.messages : [];

      for (const message of messages) {
        if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
          const files = message.files?.map((f) => ({
            name: f.name,
            title: f.title,
            mimetype: f.mimetype,
            filetype: f.filetype,
            size: f.size,
            permalink: f.permalink,
          }));
          const links = extractLinks(message.text ?? "");
          const storedMessage = await db.upsertMessage(
            workspaceId,
            channelId,
            message.ts,
            message.user ?? "",
            message.text ?? "",
            "backfill",
            message.thread_ts,
            message.subtype,
            message.bot_id,
            files && files.length > 0 ? files : null,
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
        }

        // Track threads that need reply fetching
        if (typeof message.ts === "string" && (message.reply_count ?? 0) > 0) {
          threadRoots.add(message.ts);
        }
      }

      cursor = history.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    log.info({ channelId, messageCount, threads: threadRoots.size, pages: pageCount }, "Channel history fetched");

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
        log.warn({ channelId, threadTs: rootTs, error: errMsg }, "Thread fetch failed, skipping");
      }
    }

    // Phase 2.5: Batch resolve user profiles
    const userIds = await db.getDistinctUserIds(workspaceId, channelId);
    log.info({ channelId, uniqueUsers: userIds.length }, "Resolving user profiles");
    await batchResolveUsers(workspaceId, userIds, 5);

    // Phase 2.75: Fetch channel member list from Slack
    await syncChannelMemberList(workspaceId, channelId);

    // Phase 3: Build derived state
    await refreshChannelState(workspaceId, channelId);

    const [channel, latestRule, analysisWindowDays] = await Promise.all([
      db.getChannel(workspaceId, channelId),
      db.getFollowUpRule(workspaceId, channelId),
      db.getEffectiveAnalysisWindowDays(workspaceId, channelId),
    ]);
    const importance = resolveConversationImportance({
      channelName: channel?.name ?? channelId,
      conversationType: latestRule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
      clientUserIds: latestRule?.client_user_ids ?? [],
      importanceTierOverride: latestRule?.importance_tier_override,
    });
    const totalMessages = await db.getMessageCount(workspaceId, channelId);

    // Phase 4: Materialize the first trustworthy intelligence artifact before
    // declaring the channel ready. Low-signal channels get an explicit
    // risk-only notice instead of a routine narrative summary.
    if (totalMessages === 0) {
      await db.upsertChannelState(workspaceId, channelId, {
        running_summary:
          "No supported messages were imported for this channel yet. PulseBoard is ready to monitor it, but there is no analyzable conversation history in the current ingest policy.",
        key_decisions_json: [],
      });
    } else if (tierAllowsRoutineChannelSummary(importance.effectiveImportanceTier)) {
      await materializeBackfillSummary({
        workspaceId,
        channelId,
        windowDays: analysisWindowDays,
        publishEvent: true,
      });
    } else {
      await db.upsertChannelState(workspaceId, channelId, {
        running_summary: getRiskOnlyMonitoringNotice(),
        key_decisions_json: [],
      });
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
    const seeded = await seedInitialArtifacts(workspaceId, channelId);
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
    const response = await slack.fetchThreadReplies(channelId, threadTs, cursor);
    const messages = Array.isArray(response.messages) ? response.messages : [];

    for (const message of messages) {
      if (isIngestibleHistoryMessage(message, { allowAutomatedMessages })) {
        const threadFiles = message.files?.map((f) => ({
          name: f.name,
          title: f.title,
          mimetype: f.mimetype,
          filetype: f.filetype,
          size: f.size,
          permalink: f.permalink,
        }));
        const threadLinks = extractLinks(message.text ?? "");
        const storedMessage = await db.upsertMessage(
          workspaceId,
          channelId,
          message.ts,
          message.user ?? "",
          message.text ?? "",
          "backfill",
          message.thread_ts ?? threadTs,
          message.subtype,
          message.bot_id,
          threadFiles && threadFiles.length > 0 ? threadFiles : null,
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
          await db.upsertThreadEdge(workspaceId, channelId, threadTs, message.ts);
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
  const [messages, threads, totalMessages, participantCounts] = await Promise.all([
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
