import { config } from "../config.js";
import * as db from "../db/queries.js";
import {
  enqueueBackfill,
  enqueueSummaryRollup,
  getQueue,
  getQueueRuntimeState,
} from "../queue/boss.js";
import { JOB_NAMES } from "../queue/jobTypes.js";
import { logger } from "../utils/logger.js";
import {
  resolveConversationImportance,
  tierAllowsRoutineChannelSummary,
  tierAllowsRoutineThreadInsight,
} from "./conversationImportance.js";
import type { JobWithMetadata, PgBoss } from "pg-boss";

const log = logger.child({ service: "queueMaintenance" });

const AUTO_RETRY_JOB_NAMES = [
  JOB_NAMES.BACKFILL,
  JOB_NAMES.MESSAGE_INGEST,
  JOB_NAMES.USER_RESOLVE,
  JOB_NAMES.THREAD_RECONCILE,
  JOB_NAMES.LLM_ANALYZE,
  JOB_NAMES.SUMMARY_ROLLUP,
] as const;

const RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const MAX_RECOVERED_IDS = 500;
const recoveredJobIds = new Set<string>();

/** Keep recoveredJobIds bounded — evict oldest entries when limit is reached */
function trackRecoveredJob(jobId: string): void {
  recoveredJobIds.add(jobId);
  if (recoveredJobIds.size > MAX_RECOVERED_IDS) {
    const oldest = recoveredJobIds.values().next().value;
    if (oldest !== undefined) recoveredJobIds.delete(oldest);
  }
}

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
let maintenanceRunning = false;

function isQueueShutdownError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes("Database connection is not opened") ||
    err.message.includes("Queue not started")
  );
}

function isRecentFailure(job: JobWithMetadata<unknown>): boolean {
  const referenceTime = job.completedOn ?? job.startedOn ?? job.createdOn;
  return Date.now() - referenceTime.getTime() <= RECENT_FAILURE_WINDOW_MS;
}

async function retryRecentFailedJobs(boss: PgBoss): Promise<number> {
  let retriedCount = 0;

  for (const queueName of AUTO_RETRY_JOB_NAMES) {
    const jobs = await boss.findJobs(queueName);
    const failedJobs = jobs
      .filter((job) => job.state === "failed" && isRecentFailure(job) && !recoveredJobIds.has(job.id))
      .slice(0, 5);

    for (const job of failedJobs) {
      await boss.retry(queueName, job.id);
      trackRecoveredJob(job.id);
      retriedCount += 1;
      log.warn(
        { queueName, jobId: job.id, retryCount: job.retryCount },
        "Retried failed job from maintenance loop",
      );
    }
  }

  return retriedCount;
}

async function recoverStaleChannels(): Promise<number> {
  const channels = await db.getRecoverableChannels(config.QUEUE_STALE_CHANNEL_MINUTES);
  let recoveredCount = 0;

  for (const channel of channels) {
    const jobId = await enqueueBackfill(
      channel.workspace_id,
      channel.channel_id,
      "maintenance-recovery",
    );

    if (jobId) {
      recoveredCount += 1;
      log.warn(
        { channelId: channel.channel_id, status: channel.status, jobId },
        "Re-enqueued stale channel for backfill recovery",
      );
    }
  }

  return recoveredCount;
}

async function normalizeHistoricalBackfillMessages(): Promise<number> {
  const normalized = await db.markStaleBackfillMessagesSkipped(
    config.QUEUE_STALE_ANALYSIS_MINUTES,
    config.QUEUE_STALE_SCAN_LIMIT,
  );
  const normalizedCount = normalized.reduce(
    (total, channel) => total + channel.skipped_count,
    0,
  );

  if (normalizedCount > 0) {
    log.info(
      {
        normalizedCount,
        channels: normalized.map((entry) => ({
          channelId: entry.channel_id,
          skippedCount: entry.skipped_count,
        })),
      },
      "Normalized stale backfill message statuses to skipped",
    );
  }

  return normalizedCount;
}

async function recoverStaleArtifacts(): Promise<number> {
  const candidates = await db.getStaleAnalysisCandidates(
    config.QUEUE_STALE_ANALYSIS_MINUTES,
    config.QUEUE_STALE_SCAN_LIMIT,
  );
  const scopedTargets = new Map<string, {
    workspaceId: string;
    channelId: string;
    threadTs: string | null;
  }>();
  let recoveredCount = 0;
  const policyCache = new Map<string, Awaited<ReturnType<typeof db.getFollowUpRule>>>();
  const channelCache = new Map<string, Awaited<ReturnType<typeof db.getChannel>>>();

  for (const candidate of candidates) {
    const scopeKey = [
      candidate.workspace_id,
      candidate.channel_id,
      candidate.thread_ts ?? "channel",
    ].join(":");

    const existingScope = scopedTargets.get(scopeKey);
    if (existingScope) {
      continue;
    }

    scopedTargets.set(scopeKey, {
      workspaceId: candidate.workspace_id,
      channelId: candidate.channel_id,
      threadTs: candidate.thread_ts,
    });
  }

  for (const scope of scopedTargets.values()) {
    const cacheKey = `${scope.workspaceId}:${scope.channelId}`;
    if (!policyCache.has(cacheKey)) {
      policyCache.set(
        cacheKey,
        await db.getFollowUpRule(scope.workspaceId, scope.channelId),
      );
    }
    if (!channelCache.has(cacheKey)) {
      channelCache.set(
        cacheKey,
        await db.getChannel(scope.workspaceId, scope.channelId),
      );
    }

    const rule = policyCache.get(cacheKey) ?? null;
    const channel = channelCache.get(cacheKey) ?? null;
    const importance = resolveConversationImportance({
      channelName: channel?.name ?? scope.channelId,
      conversationType: rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
      clientUserIds: rule?.client_user_ids ?? [],
      importanceTierOverride: rule?.importance_tier_override,
    });
    const canRecoverScope = scope.threadTs
      ? tierAllowsRoutineThreadInsight(importance.effectiveImportanceTier)
      : tierAllowsRoutineChannelSummary(importance.effectiveImportanceTier);

    if (!canRecoverScope) {
      log.warn(
        {
          channelId: scope.channelId,
          threadTs: scope.threadTs,
          importanceTier: importance.effectiveImportanceTier,
        },
        "Skipped stale artifact recovery because the channel is in risk-only mode",
      );
      continue;
    }

    const jobId = await enqueueSummaryRollup({
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      rollupType: scope.threadTs ? "thread" : "channel",
      threadTs: scope.threadTs,
      requestedBy: "manual",
    });

    if (jobId) {
      recoveredCount += 1;
      log.warn(
        {
          channelId: scope.channelId,
          threadTs: scope.threadTs,
          importanceTier: importance.effectiveImportanceTier,
          jobId,
        },
        "Re-enqueued stale artifact scope from maintenance loop",
      );
    }
  }

  return recoveredCount;
}

export async function runQueueMaintenanceOnce(): Promise<void> {
  const queueState = getQueueRuntimeState();
  if (!queueState.started) {
    return;
  }

  const boss = getQueue();
  if (!boss) {
    return;
  }

  try {
    await boss.supervise();

    const retriedFailedJobs = await retryRecentFailedJobs(boss);
    const recoveredChannels = await recoverStaleChannels();
    const normalizedHistoricalMessages = await normalizeHistoricalBackfillMessages();
    const recoveredArtifacts = await recoverStaleArtifacts();

    if (
      retriedFailedJobs > 0 ||
      recoveredChannels > 0 ||
      normalizedHistoricalMessages > 0 ||
      recoveredArtifacts > 0
    ) {
      log.info(
        {
          retriedFailedJobs,
          recoveredChannels,
          normalizedHistoricalMessages,
          recoveredArtifacts,
        },
        "Queue maintenance recovered stale work",
      );
    }
  } catch (err) {
    if (isQueueShutdownError(err)) {
      log.info("Queue maintenance skipped because the queue is shutting down");
      return;
    }
    throw err;
  }
}

function scheduleNextRun(): void {
  maintenanceTimer = setTimeout(async () => {
    if (!maintenanceRunning) {
      maintenanceRunning = true;
      try {
        await runQueueMaintenanceOnce();
      } catch (err) {
        log.error({ err }, "Queue maintenance iteration failed");
      } finally {
        maintenanceRunning = false;
      }
    }

    if (maintenanceTimer !== null) {
      scheduleNextRun();
    }
  }, config.QUEUE_MAINTENANCE_INTERVAL_MS);

  maintenanceTimer.unref?.();
}

export function startQueueMaintenance(): void {
  if (maintenanceTimer) {
    log.warn("Queue maintenance loop already running");
    return;
  }

  void runQueueMaintenanceOnce().catch((err) => {
    log.error({ err }, "Initial queue maintenance iteration failed");
  });

  scheduleNextRun();
  log.info(
    {
      intervalMs: config.QUEUE_MAINTENANCE_INTERVAL_MS,
      staleChannelMinutes: config.QUEUE_STALE_CHANNEL_MINUTES,
      staleAnalysisMinutes: config.QUEUE_STALE_ANALYSIS_MINUTES,
    },
    "Queue maintenance loop started",
  );
}

export function stopQueueMaintenance(): void {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
    log.info("Queue maintenance loop stopped");
  }
}
