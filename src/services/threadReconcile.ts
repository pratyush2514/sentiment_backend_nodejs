import {
  RECONCILE_BASE_INTERVAL_MS,
  RECONCILE_JITTER_MS,
  RECONCILE_ACTIVE_THREAD_HOURS,
  RECONCILE_MAX_PAGES,
} from "../constants.js";
import * as db from "../db/queries.js";
import { enqueueMessageIngest, enqueueThreadReconcile } from "../queue/boss.js";
import { isIngestibleHistoryMessage } from "../types/slack.js";
import { logger } from "../utils/logger.js";
import { allowsAutomatedMessageIngestion } from "./channelMessagePolicy.js";
import { getSlackClient } from "./slackClientFactory.js";
import {
  extractSlackMessageText,
  mapSlackFiles,
} from "./slackMessageContent.js";
import { extractLinks } from "./textNormalizer.js";
import type { ChannelRow } from "../types/database.js";

const log = logger.child({ service: "threadReconcile" });

const BASE_INTERVAL_MS = RECONCILE_BASE_INTERVAL_MS;
const JITTER_MS = RECONCILE_JITTER_MS;
const HISTORY_RECONCILE_OVERLAP_MS = 15 * 60 * 1000;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function getJitteredInterval(): number {
  return BASE_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
}

/**
 * Start the periodic thread reconciliation loop.
 * Runs every ~5 minutes (with jitter) and enqueues thread.reconcile jobs for all ready channels.
 */
let stopped = true;

export function startReconcileLoop(): void {
  if (reconcileTimer) {
    log.warn("Reconcile loop already running");
    return;
  }

  stopped = false;

  log.info(
    { baseIntervalMs: BASE_INTERVAL_MS, jitterMs: JITTER_MS },
    "Starting thread reconciliation loop",
  );

  scheduleNext();
}

function scheduleNext(): void {
  if (stopped) return;
  const interval = getJitteredInterval();
  reconcileTimer = setTimeout(() => {
    enqueueReconcileForActiveChannels()
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.error({ error: errMsg }, "Reconcile loop iteration failed");
      })
      .finally(() => {
        if (!stopped) {
          scheduleNext();
        }
      });
  }, interval);
}

/**
 * Stop the periodic reconciliation loop.
 */
export function stopReconcileLoop(): void {
  stopped = true;
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    log.info("Reconcile loop stopped");
  }
}

/**
 * Find all ready channels and enqueue a thread.reconcile job for each.
 */
async function enqueueReconcileForActiveChannels(): Promise<void> {
  const channels = await db.getReadyChannels();

  if (channels.length === 0) {
    log.debug("No ready channels for reconciliation");
    return;
  }

  // Filter to channels that haven't been reconciled in the last 4 minutes
  // (the reconcile loop runs every 5 min, so this prevents double-enqueue)
  const RECONCILE_COOLDOWN_MS = 4 * 60 * 1000;
  const now = Date.now();
  const eligible = channels.filter((ch) => {
    const lastReconcile = ch.last_reconcile_at ? new Date(ch.last_reconcile_at).getTime() : 0;
    return now - lastReconcile > RECONCILE_COOLDOWN_MS;
  });

  if (eligible.length === 0) {
    log.debug("All ready channels recently reconciled, skipping");
    return;
  }

  log.info({ channelCount: eligible.length }, "Enqueuing thread reconcile jobs");

  for (const channel of eligible) {
    try {
      await enqueueThreadReconcile(channel.workspace_id, channel.channel_id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { channelId: channel.channel_id, error: errMsg },
        "Failed to enqueue thread reconcile",
      );
    }
  }
}

/**
 * Reconcile threads for a single channel.
 * Finds active threads (last 24h), re-fetches replies, upserts missing ones.
 */
export async function reconcileChannelThreads(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const channel = await db.getChannel(workspaceId, channelId);
  const recoveredTopLevelMessages = channel
    ? await reconcileRecentChannelHistory(channel)
    : 0;
  const activeThreads = await db.getActiveThreads(workspaceId, channelId, RECONCILE_ACTIVE_THREAD_HOURS);

  if (activeThreads.length === 0) {
    if (recoveredTopLevelMessages > 0) {
      await db.updateLastReconcileAt(workspaceId, channelId);
      log.info(
        { channelId, recoveredTopLevelMessages },
        "Recovered recent top-level messages without active threads to reconcile",
      );
      return;
    }

    log.debug({ channelId }, "No active threads to reconcile");
    return;
  }

  log.info(
    { channelId, threadCount: activeThreads.length },
    "Reconciling active threads",
  );

  let reconciledCount = 0;
  let newRepliesCount = 0;

  for (const thread of activeThreads) {
    try {
      const newReplies = await reconcileSingleThread(
        workspaceId,
        channelId,
        thread.thread_ts,
      );
      if (newReplies > 0) {
        reconciledCount++;
        newRepliesCount += newReplies;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { channelId, threadTs: thread.thread_ts, error: errMsg },
        "Thread reconcile failed, skipping",
      );
    }
  }

  await db.updateLastReconcileAt(workspaceId, channelId);

  log.info(
    { channelId, reconciledCount, newRepliesCount, recoveredTopLevelMessages },
    "Thread reconciliation complete",
  );
}

function buildRecentHistoryOldest(channel: ChannelRow): string {
  const floorMs = Date.now() - RECONCILE_ACTIVE_THREAD_HOURS * 60 * 60 * 1000;
  const channelLastEventMs = channel.last_event_at
    ? channel.last_event_at.getTime() - HISTORY_RECONCILE_OVERLAP_MS
    : floorMs;
  const oldestMs = Math.max(floorMs, channelLastEventMs);
  return String(Math.floor(oldestMs / 1000));
}

async function reconcileRecentChannelHistory(
  channel: ChannelRow,
): Promise<number> {
  const slack = await getSlackClient(channel.workspace_id);
  const oldest = buildRecentHistoryOldest(channel);
  let cursor: string | undefined;
  let pageCount = 0;
  let recoveredCount = 0;
  const maxPages = RECONCILE_MAX_PAGES;
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(channel.name);

  while (pageCount < maxPages) {
    pageCount += 1;
    const response = await slack.fetchChannelHistory(channel.channel_id, oldest, cursor);
    const historyMessages = Array.isArray(response.messages) ? response.messages : [];
    const ingestibleMessages = historyMessages.filter((message) =>
      isIngestibleHistoryMessage(message, { allowAutomatedMessages }),
    );

    if (ingestibleMessages.length > 0) {
      const existing = await db.getMessagesByTs(
        channel.workspace_id,
        channel.channel_id,
        ingestibleMessages.map((message) => message.ts as string),
      );
      const existingTs = new Set(existing.map((message) => message.ts));

      for (const message of ingestibleMessages) {
        if (existingTs.has(message.ts)) {
          continue;
        }

        const files = mapSlackFiles(message.files);
        const extractedText = extractSlackMessageText(message);

        await enqueueMessageIngest({
          workspaceId: channel.workspace_id,
          channelId: channel.channel_id,
          ts: message.ts,
          userId: message.user,
          text: extractedText,
          threadTs: message.thread_ts ?? null,
          eventId: `reconcile:${channel.channel_id}:${message.ts}`,
          ...(message.subtype ? { subtype: message.subtype } : {}),
          ...(message.bot_id ? { botId: message.bot_id } : {}),
          files: files ?? undefined,
        });

        existingTs.add(message.ts);
        recoveredCount += 1;
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }

  if (recoveredCount > 0) {
    log.info(
      {
        channelId: channel.channel_id,
        workspaceId: channel.workspace_id,
        recoveredCount,
        oldest,
      },
      "Recovered missed recent channel messages from Slack history",
    );
  }

  return recoveredCount;
}

/**
 * Reconcile a single thread — fetch all replies from Slack and upsert missing ones.
 */
async function reconcileSingleThread(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<number> {
  let newReplies = 0;
  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = RECONCILE_MAX_PAGES;
  const channel = await db.getChannel(workspaceId, channelId);
  const allowAutomatedMessages = allowsAutomatedMessageIngestion(channel?.name);

  const slack = await getSlackClient(workspaceId);

  while (pageCount < maxPages) {
    pageCount++;
    const response = await slack.fetchThreadReplies(channelId, threadTs, cursor);
    const messages = Array.isArray(response.messages) ? response.messages : [];

    for (const message of messages) {
      if (
        isIngestibleHistoryMessage(message, { allowAutomatedMessages }) &&
        message.ts !== threadTs
      ) {
        const filesMeta = mapSlackFiles(message.files);
        const extractedText = extractSlackMessageText(message);
        const linksMeta = extractLinks(extractedText);
        const result = await db.upsertMessage(
          workspaceId,
          channelId,
          message.ts,
          message.user,
          extractedText,
          "backfill",
          message.thread_ts ?? threadTs,
          message.subtype,
          message.bot_id,
          filesMeta,
          linksMeta.length > 0 ? linksMeta : null,
        );

        // Detect new inserts: created_at equals updated_at on fresh rows
        if (result.created_at.getTime() === result.updated_at.getTime()) {
          newReplies++;
        }

        await db.upsertThreadEdge(workspaceId, channelId, threadTs, message.ts);
      }
    }

    cursor = response.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  if (newReplies > 0) {
    log.info({ channelId, threadTs, newReplies }, "Thread reconciled with new replies");
  }

  return newReplies;
}
