import {
  RECONCILE_BASE_INTERVAL_MS,
  RECONCILE_JITTER_MS,
  RECONCILE_ACTIVE_THREAD_HOURS,
  RECONCILE_MAX_PAGES,
} from "../constants.js";
import * as db from "../db/queries.js";
import { enqueueThreadReconcile } from "../queue/boss.js";
import { isHumanMessage } from "../types/slack.js";
import { logger } from "../utils/logger.js";
import { fetchThreadReplies } from "./slackClient.js";

const log = logger.child({ service: "threadReconcile" });

const BASE_INTERVAL_MS = RECONCILE_BASE_INTERVAL_MS;
const JITTER_MS = RECONCILE_JITTER_MS;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function getJitteredInterval(): number {
  return BASE_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
}

/**
 * Start the periodic thread reconciliation loop.
 * Runs every ~5 minutes (with jitter) and enqueues thread.reconcile jobs for all ready channels.
 */
export function startReconcileLoop(): void {
  if (reconcileTimer) {
    log.warn("Reconcile loop already running");
    return;
  }

  log.info(
    { baseIntervalMs: BASE_INTERVAL_MS, jitterMs: JITTER_MS },
    "Starting thread reconciliation loop",
  );

  scheduleNext();
}

function scheduleNext(): void {
  const interval = getJitteredInterval();
  reconcileTimer = setTimeout(() => {
    enqueueReconcileForActiveChannels()
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : "unknown";
        log.error({ error: errMsg }, "Reconcile loop iteration failed");
      })
      .finally(() => {
        if (reconcileTimer !== null) {
          scheduleNext();
        }
      });
  }, interval);
}

/**
 * Stop the periodic reconciliation loop.
 */
export function stopReconcileLoop(): void {
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

  log.info({ channelCount: channels.length }, "Enqueuing thread reconcile jobs");

  for (const channel of channels) {
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
  const activeThreads = await db.getActiveThreads(workspaceId, channelId, RECONCILE_ACTIVE_THREAD_HOURS);

  if (activeThreads.length === 0) {
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
    { channelId, reconciledCount, newRepliesCount },
    "Thread reconciliation complete",
  );
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

  while (pageCount < maxPages) {
    pageCount++;
    const response = await fetchThreadReplies(channelId, threadTs, cursor);
    const messages = Array.isArray(response.messages) ? response.messages : [];

    for (const message of messages) {
      if (isHumanMessage(message) && message.ts !== threadTs) {
        const result = await db.upsertMessage(
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
