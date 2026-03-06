import { config } from "../config.js";
import * as db from "../db/queries.js";
import { enqueueSummaryRollup } from "../queue/boss.js";
import { isHumanMessage } from "../types/slack.js";
import { logger } from "../utils/logger.js";
import { fetchChannelHistory, fetchThreadReplies } from "./slackClient.js";
import { batchResolveUsers } from "./userProfiles.js";

const log = logger.child({ service: "backfill" });

export async function runBackfill(
  workspaceId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  log.info({ channelId, reason, days: config.BACKFILL_DAYS }, "Backfill started");

  await db.updateChannelStatus(workspaceId, channelId, "initializing");

  const oldest = String(
    Math.floor(Date.now() / 1000) - config.BACKFILL_DAYS * 24 * 60 * 60,
  );

  let cursor: string | undefined;
  let pageCount = 0;
  let messageCount = 0;
  const threadRoots = new Set<string>();

  try {
    // Phase 1: Fetch channel history
    while (pageCount < config.BACKFILL_MAX_PAGES) {
      pageCount += 1;
      const history = await fetchChannelHistory(channelId, oldest, cursor);
      const messages = Array.isArray(history.messages) ? history.messages : [];

      for (const message of messages) {
        if (isHumanMessage(message)) {
          await db.upsertMessage(
            workspaceId,
            channelId,
            message.ts,
            message.user,
            message.text,
            "backfill",
            message.thread_ts,
            message.subtype,
            message.bot_id,
          );
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
        await fetchAndStoreThread(workspaceId, channelId, rootTs);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.warn({ channelId, threadTs: rootTs, error: errMsg }, "Thread fetch failed, skipping");
      }
    }

    // Phase 2.5: Batch resolve user profiles
    const userIds = await db.getDistinctUserIds(workspaceId, channelId);
    log.info({ channelId, uniqueUsers: userIds.length }, "Resolving user profiles");
    await batchResolveUsers(workspaceId, userIds, 5);

    // Phase 3: Build derived state
    await refreshChannelState(workspaceId, channelId);

    // Phase 4: Enqueue LLM-powered backfill rollup (replaces basic snippet with rich summary)
    await enqueueSummaryRollup({
      workspaceId,
      channelId,
      rollupType: "backfill",
    });

    await db.updateChannelStatus(workspaceId, channelId, "ready");

    const totalMessages = await db.getMessageCount(workspaceId, channelId);
    log.info({ channelId, totalMessages }, "Backfill complete");
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
): Promise<void> {
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < config.BACKFILL_MAX_PAGES) {
    pageCount += 1;
    const response = await fetchThreadReplies(channelId, threadTs, cursor);
    const messages = Array.isArray(response.messages) ? response.messages : [];

    for (const message of messages) {
      if (isHumanMessage(message)) {
        await db.upsertMessage(
          workspaceId,
          channelId,
          message.ts,
          message.user,
          message.text,
          "backfill",
          message.thread_ts ?? threadTs,
          message.subtype,
          message.bot_id,
        );

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
  const messages = await db.getMessages(workspaceId, channelId, { limit: 200 });
  const threads = await db.getThreads(workspaceId, channelId);
  const totalMessages = await db.getMessageCount(workspaceId, channelId);

  // Build participants map
  const participants: Record<string, number> = {};
  for (const msg of messages) {
    participants[msg.user_id] = (participants[msg.user_id] ?? 0) + 1;
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
    })
    .join(", ");

  const recentSnippets = messages
    .slice(-5)
    .map((m) => m.text.slice(0, 100))
    .join(" | ");

  const runningSummary = [
    `Backfilled ${totalMessages} human messages.`,
    `Threads: ${threads.length}.`,
    topParticipants ? `Top participants: ${topParticipants}.` : "No participants yet.",
    recentSnippets ? `Recent: ${recentSnippets}` : "No recent messages.",
  ].join(" ");

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
    },
  });
}
