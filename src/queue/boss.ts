import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { TARGET_MESSAGE_COUNT } from "../constants.js";
import { markQueueRuntimeState } from "../services/runtimeState.js";
import { logger } from "../utils/logger.js";
import { handleLLMAnalyze } from "./handlers/analyzeHandler.js";
import { handleBackfill } from "./handlers/backfillHandler.js";
import { handleBackfillTier1 } from "./handlers/backfillTier1Handler.js";
import { handleBackfillTier2 } from "./handlers/backfillTier2Handler.js";
import { handleBackfillTier3 } from "./handlers/backfillTier3Handler.js";
import { handleChannelDiscovery } from "./handlers/channelDiscoveryHandler.js";
import { handleChannelClassify } from "./handlers/classifyHandler.js";
import { handleMeetingDigest } from "./handlers/meetingDigestHandler.js";
import { handleMeetingExtract } from "./handlers/meetingExtractHandler.js";
import { handleMeetingHistoricalSync } from "./handlers/meetingHistoricalSyncHandler.js";
import { handleMeetingIngest } from "./handlers/meetingIngestHandler.js";
import { handleMeetingObligationSync } from "./handlers/meetingObligationSyncHandler.js";
import { handleMessageIngest } from "./handlers/messageHandler.js";
import { handleThreadReconcile } from "./handlers/reconcileHandler.js";
import { handleSummaryRollup } from "./handlers/rollupHandler.js";
import { handleUserResolve } from "./handlers/userResolveHandler.js";
import { JOB_NAMES, QUEUE_CONFIG } from "./jobTypes.js";
import type {
  BackfillJob,
  BackfillTier1Job,
  BackfillTier2Job,
  BackfillTier3Job,
  MessageIngestJob,
  UserResolveJob,
  ThreadReconcileJob,
  LLMAnalyzeJob,
  SummaryRollupJob,
  ChannelDiscoveryJob,
  MeetingHistoricalSyncJob,
  MeetingIngestJob,
  MeetingExtractJob,
  MeetingDigestJob,
  MeetingObligationSyncJob,
  ChannelClassifyJob,
  QueueRuntimeOptions,
} from "./jobTypes.js";

const log = logger.child({ service: "pgBoss" });

let boss: PgBoss | null = null;
let queueRuntimeState = {
  started: false,
  workersRegistered: false,
};

function isRouteTriggeredThreadRollup(data: SummaryRollupJob): boolean {
  return data.rollupType === "thread" && (
    data.requestedBy === "state_route" ||
    data.requestedBy === "messages_route" ||
    data.requestedBy === "threads_route" ||
    data.requestedBy === "alerts_route"
  );
}

export function buildSummaryRollupSingletonKey(data: SummaryRollupJob): string {
  return `rollup:${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}`;
}

function chunkTargetMessageTs(targetMessageTs: string[]): string[][] {
  const uniqueTargets = Array.from(new Set(targetMessageTs))
    .filter((ts) => ts.length > 0)
    .sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));

  const chunks: string[][] = [];
  for (let index = 0; index < uniqueTargets.length; index += TARGET_MESSAGE_COUNT) {
    chunks.push(uniqueTargets.slice(index, index + TARGET_MESSAGE_COUNT));
  }

  return chunks;
}

export async function startQueue(
  options: QueueRuntimeOptions = {},
): Promise<PgBoss> {
  boss = new PgBoss({
    connectionString: config.DATABASE_URL, // Direct connection for LISTEN/NOTIFY
    schema: "pgboss",
    monitorIntervalSeconds: 10,
    max: config.PGBOSS_MAX_CONNECTIONS,
    connectionTimeoutMillis: 30_000, // Allow more time during connection spikes
  });

  boss.on("error", (err: Error) => {
    log.error({ err }, "pg-boss error");
  });

  await boss.start();
  log.info("pg-boss started");
  queueRuntimeState = {
    started: true,
    workersRegistered: false,
  };
  markQueueRuntimeState({
    queueStarted: true,
    workersRegistered: false,
  });

  // Create queues (pg-boss v12 requires explicit queue creation)
  await boss.createQueue(JOB_NAMES.BACKFILL);
  await boss.createQueue(JOB_NAMES.MESSAGE_INGEST);
  await boss.createQueue(JOB_NAMES.USER_RESOLVE);
  await boss.createQueue(JOB_NAMES.THREAD_RECONCILE);
  await boss.createQueue(JOB_NAMES.LLM_ANALYZE);
  await boss.createQueue(JOB_NAMES.SUMMARY_ROLLUP);
  await boss.createQueue(JOB_NAMES.CHANNEL_DISCOVERY);
  await boss.createQueue(JOB_NAMES.CHANNEL_CLASSIFY);

  // Tiered backfill queues
  await boss.createQueue(JOB_NAMES.BACKFILL_TIER1);
  await boss.createQueue(JOB_NAMES.BACKFILL_TIER2);
  await boss.createQueue(JOB_NAMES.BACKFILL_TIER3);

  // Fathom meeting pipeline queues
  if (config.FATHOM_ENABLED) {
    await boss.createQueue(JOB_NAMES.MEETING_INGEST);
    await boss.createQueue(JOB_NAMES.MEETING_HISTORICAL_SYNC);
    await boss.createQueue(JOB_NAMES.MEETING_EXTRACT);
    await boss.createQueue(JOB_NAMES.MEETING_DIGEST);
    await boss.createQueue(JOB_NAMES.MEETING_OBLIGATION_SYNC);
  }

  log.info("Queues created");

  if (options.registerWorkers !== false) {
    await boss.work<BackfillJob>(
      JOB_NAMES.BACKFILL,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.BACKFILL].localConcurrency,
      },
      handleBackfill,
    );

    await boss.work<MessageIngestJob>(
      JOB_NAMES.MESSAGE_INGEST,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.MESSAGE_INGEST].localConcurrency,
      },
      handleMessageIngest,
    );

    await boss.work<UserResolveJob>(
      JOB_NAMES.USER_RESOLVE,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.USER_RESOLVE].localConcurrency,
      },
      handleUserResolve,
    );

    await boss.work<ThreadReconcileJob>(
      JOB_NAMES.THREAD_RECONCILE,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.THREAD_RECONCILE].localConcurrency,
      },
      handleThreadReconcile,
    );

    await boss.work<LLMAnalyzeJob>(
      JOB_NAMES.LLM_ANALYZE,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].localConcurrency,
      },
      handleLLMAnalyze,
    );

    await boss.work<SummaryRollupJob>(
      JOB_NAMES.SUMMARY_ROLLUP,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].localConcurrency,
      },
      handleSummaryRollup,
    );

    await boss.work<ChannelDiscoveryJob>(
      JOB_NAMES.CHANNEL_DISCOVERY,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.CHANNEL_DISCOVERY].localConcurrency,
      },
      handleChannelDiscovery,
    );

    await boss.work<ChannelClassifyJob>(
      JOB_NAMES.CHANNEL_CLASSIFY,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.CHANNEL_CLASSIFY].localConcurrency,
      },
      handleChannelClassify,
    );

    // Tiered backfill workers
    await boss.work<BackfillTier1Job>(
      JOB_NAMES.BACKFILL_TIER1,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER1].localConcurrency,
      },
      handleBackfillTier1,
    );

    await boss.work<BackfillTier2Job>(
      JOB_NAMES.BACKFILL_TIER2,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER2].localConcurrency,
      },
      handleBackfillTier2,
    );

    await boss.work<BackfillTier3Job>(
      JOB_NAMES.BACKFILL_TIER3,
      {
        localConcurrency: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER3].localConcurrency,
      },
      handleBackfillTier3,
    );

    // Meeting pipeline workers (only when Fathom is enabled)
    if (config.FATHOM_ENABLED) {
      await boss.work<MeetingIngestJob>(
        JOB_NAMES.MEETING_INGEST,
        {
          localConcurrency: QUEUE_CONFIG[JOB_NAMES.MEETING_INGEST].localConcurrency,
        },
        handleMeetingIngest,
      );

      await boss.work<MeetingHistoricalSyncJob>(
        JOB_NAMES.MEETING_HISTORICAL_SYNC,
        {
          localConcurrency: QUEUE_CONFIG[JOB_NAMES.MEETING_HISTORICAL_SYNC].localConcurrency,
        },
        handleMeetingHistoricalSync,
      );

      await boss.work<MeetingExtractJob>(
        JOB_NAMES.MEETING_EXTRACT,
        {
          localConcurrency: QUEUE_CONFIG[JOB_NAMES.MEETING_EXTRACT].localConcurrency,
        },
        handleMeetingExtract,
      );

      await boss.work<MeetingDigestJob>(
        JOB_NAMES.MEETING_DIGEST,
        {
          localConcurrency: QUEUE_CONFIG[JOB_NAMES.MEETING_DIGEST].localConcurrency,
        },
        handleMeetingDigest,
      );

      await boss.work<MeetingObligationSyncJob>(
        JOB_NAMES.MEETING_OBLIGATION_SYNC,
        {
          localConcurrency: QUEUE_CONFIG[JOB_NAMES.MEETING_OBLIGATION_SYNC].localConcurrency,
        },
        handleMeetingObligationSync,
      );

      log.info("Meeting pipeline workers registered (Fathom enabled)");
    }

    queueRuntimeState = {
      started: true,
      workersRegistered: true,
    };
    markQueueRuntimeState({
      queueStarted: true,
      workersRegistered: true,
    });
    log.info("Job handlers registered");
  } else {
    log.info("Queue started in producer-only mode");
  }
  return boss;
}

export async function enqueueBackfill(
  workspaceId: string,
  channelId: string,
  reason: string,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.BACKFILL, {
    workspaceId,
    channelId,
    reason,
  }, {
    singletonKey: `${workspaceId}:${channelId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.BACKFILL].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.BACKFILL].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.BACKFILL].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.BACKFILL].expireInSeconds,
  });

  log.info({ jobId, channelId, reason }, "Backfill job enqueued");
  return jobId;
}

export async function enqueueMessageIngest(
  data: MessageIngestJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MESSAGE_INGEST, data, {
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MESSAGE_INGEST].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MESSAGE_INGEST].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MESSAGE_INGEST].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MESSAGE_INGEST].expireInSeconds,
  });

  return jobId;
}

export async function enqueueUserResolve(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.USER_RESOLVE, {
    workspaceId,
    userId,
  }, {
    singletonKey: `${workspaceId}:${userId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.USER_RESOLVE].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.USER_RESOLVE].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.USER_RESOLVE].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.USER_RESOLVE].expireInSeconds,
  });

  return jobId;
}

export async function enqueueThreadReconcile(
  workspaceId: string,
  channelId: string,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.THREAD_RECONCILE, {
    workspaceId,
    channelId,
  }, {
    singletonKey: `reconcile:${workspaceId}:${channelId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.THREAD_RECONCILE].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.THREAD_RECONCILE].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.THREAD_RECONCILE].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.THREAD_RECONCILE].expireInSeconds,
  });

  return jobId;
}

export async function enqueueLLMAnalyze(
  data: LLMAnalyzeJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const singletonKey = data.targetMessageTs && data.targetMessageTs.length > 0
    ? `llm:${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}:${data.mode ?? "latest"}:${data.targetMessageTs.join(",")}`
    : `llm:${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}:${data.mode ?? "latest"}`;

  const jobId = await boss.send(JOB_NAMES.LLM_ANALYZE, data, {
    singletonKey,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].expireInSeconds,
  });

  log.info({ jobId, channelId: data.channelId, triggerType: data.triggerType }, "LLM analyze job enqueued");
  return jobId;
}

export async function enqueueLLMAnalyzeBatches(
  data: Omit<LLMAnalyzeJob, "targetMessageTs"> & { targetMessageTs: string[] },
): Promise<string[]> {
  const chunks = chunkTargetMessageTs(data.targetMessageTs);
  const jobIds: string[] = [];

  for (const chunk of chunks) {
    const jobId = await enqueueLLMAnalyze({
      ...data,
      targetMessageTs: chunk,
    });

    if (jobId) {
      jobIds.push(jobId);
    }
  }

  return jobIds;
}

export async function enqueueRealtimeLLMAnalyze(
  data: LLMAnalyzeJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const debounceSeconds = config.REALTIME_LLM_DEBOUNCE_SEC;
  const debounceKey = `${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}`;

  const jobId = await boss.sendDebounced(
    JOB_NAMES.LLM_ANALYZE,
    data,
    {
      retryLimit: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryLimit,
      retryDelay: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryDelay,
      retryBackoff: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryBackoff,
      expireInSeconds: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].expireInSeconds,
    },
    debounceSeconds,
    debounceKey,
  );

  log.debug(
    {
      jobId,
      channelId: data.channelId,
      triggerType: data.triggerType,
      debounceSeconds,
      debounceKey,
      mode: data.mode ?? "latest",
    },
    "Realtime LLM analyze job debounced",
  );
  return jobId;
}

export async function enqueueSummaryRollup(
  data: SummaryRollupJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const singletonKey = buildSummaryRollupSingletonKey(data);
  const routeTriggeredThreadRollup = isRouteTriggeredThreadRollup(data);
  const routeRefreshCooldownSeconds = config.THREAD_INSIGHT_ROUTE_REFRESH_COOLDOWN_SEC ?? 20;
  const jobId = await boss.send(JOB_NAMES.SUMMARY_ROLLUP, data, {
    singletonKey,
    ...(routeTriggeredThreadRollup
      ? { singletonSeconds: routeRefreshCooldownSeconds }
      : {}),
    retryLimit: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].expireInSeconds,
  });

  const logPayload = {
    jobId,
    channelId: data.channelId,
    rollupType: data.rollupType,
    threadTs: data.threadTs ?? null,
    requestedBy: data.requestedBy ?? "manual",
    singletonKey,
    routeRefreshCooldownSeconds: routeTriggeredThreadRollup ? routeRefreshCooldownSeconds : null,
  };

  if (jobId) {
    log.info(logPayload, "Summary rollup requested");
  } else {
    log.debug(logPayload, "Summary rollup request deduped");
  }
  return jobId;
}

export async function enqueueChannelDiscovery(
  workspaceId: string,
  reason: ChannelDiscoveryJob["reason"],
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.CHANNEL_DISCOVERY, {
    workspaceId,
    reason,
  }, {
    singletonKey: `discovery:${workspaceId}`,
    singletonSeconds: 300, // 5 min — prevent re-enqueue within 5 min of last job
    retryLimit: QUEUE_CONFIG[JOB_NAMES.CHANNEL_DISCOVERY].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.CHANNEL_DISCOVERY].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.CHANNEL_DISCOVERY].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.CHANNEL_DISCOVERY].expireInSeconds,
  });

  log.info({ jobId, workspaceId, reason }, "Channel discovery job enqueued");
  return jobId;
}

export async function enqueueChannelClassify(
  workspaceId: string,
  channelId: string,
  source: ChannelClassifyJob["source"],
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.CHANNEL_CLASSIFY, {
    workspaceId,
    channelId,
    source,
  }, {
    singletonKey: `classify:${workspaceId}:${channelId}`,
    singletonSeconds: 600, // 10 min — don't re-classify the same channel within 10 min
    retryLimit: QUEUE_CONFIG[JOB_NAMES.CHANNEL_CLASSIFY].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.CHANNEL_CLASSIFY].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.CHANNEL_CLASSIFY].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.CHANNEL_CLASSIFY].expireInSeconds,
  });

  log.info({ jobId, workspaceId, channelId, source }, "Channel classify job enqueued");
  return jobId;
}

export async function purgeAllJobs(): Promise<number> {
  if (!boss) throw new Error("Queue not started");

  const names = Object.values(JOB_NAMES);
  for (const name of names) {
    await boss.deleteQueuedJobs(name);
  }
  log.info({ queues: names.length }, "All queued jobs purged");
  return names.length;
}

/**
 * Cancel all pending/created jobs that belong to a specific workspace.
 * Uses pg-boss's findJobs + cancel to target only jobs for the given workspace.
 */
export async function cancelWorkspaceJobs(workspaceId: string): Promise<number> {
  if (!boss) throw new Error("Queue not started");

  let cancelled = 0;
  for (const name of Object.values(JOB_NAMES)) {
    const jobs = await boss.findJobs(name);
    const workspaceJobs = jobs.filter(
      (job) =>
        ["created", "retry", "active"].includes(job.state) &&
        (job.data as Record<string, unknown>)?.workspaceId === workspaceId,
    );
    for (const job of workspaceJobs) {
      await boss.cancel(name, job.id);
      cancelled++;
    }
  }

  if (cancelled > 0) {
    log.info({ workspaceId, cancelled }, "Cancelled workspace jobs");
  }
  return cancelled;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    queueRuntimeState = {
      started: false,
      workersRegistered: false,
    };
    markQueueRuntimeState({
      queueStarted: false,
      workersRegistered: false,
    });
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
    log.info("pg-boss stopped");
  }
}

export function getQueue(): PgBoss | null {
  return boss;
}

export function getQueueRuntimeState(): {
  started: boolean;
  workersRegistered: boolean;
} {
  return { ...queueRuntimeState };
}

// ─── Tiered Backfill Enqueue Helpers ─────────────────────────────────────────

export async function enqueueBackfillTier1(
  workspaceId: string,
  channelId: string,
  reason: string,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.BACKFILL_TIER1, {
    workspaceId,
    channelId,
    reason,
  }, {
    singletonKey: `tier1:${workspaceId}:${channelId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER1].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER1].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER1].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER1].expireInSeconds,
  });

  log.info({ jobId, channelId, reason }, "Backfill tier 1 job enqueued");
  return jobId;
}

export async function enqueueBackfillTier2(
  workspaceId: string,
  channelId: string,
  backfillRunId: string,
  reason: string,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.BACKFILL_TIER2, {
    workspaceId,
    channelId,
    backfillRunId,
    reason,
  }, {
    retryLimit: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER2].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER2].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER2].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER2].expireInSeconds,
  });

  log.info({ jobId, channelId, backfillRunId, reason }, "Backfill tier 2 job enqueued");
  return jobId;
}

export async function enqueueBackfillTier3(
  workspaceId: string,
  channelId: string,
  backfillRunId: string,
  reason: string,
  tier2CoverageOldestTs: string | null,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.BACKFILL_TIER3, {
    workspaceId,
    channelId,
    backfillRunId,
    reason,
    tier2CoverageOldestTs,
  }, {
    singletonKey: `tier3:${workspaceId}:${channelId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER3].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER3].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER3].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.BACKFILL_TIER3].expireInSeconds,
  });

  log.info({ jobId, channelId, backfillRunId, reason }, "Backfill tier 3 job enqueued");
  return jobId;
}

// ─── Meeting Pipeline Enqueue Helpers ────────────────────────────────────────

export async function enqueueMeetingIngest(
  data: MeetingIngestJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MEETING_INGEST, data, {
    singletonKey: `meeting-ingest:${data.workspaceId}:${data.fathomCallId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MEETING_INGEST].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MEETING_INGEST].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MEETING_INGEST].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MEETING_INGEST].expireInSeconds,
  });

  log.info({ jobId, fathomCallId: data.fathomCallId }, "Meeting ingest job enqueued");
  return jobId;
}

export async function enqueueMeetingHistoricalSync(
  data: MeetingHistoricalSyncJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MEETING_HISTORICAL_SYNC, data, {
    singletonKey: `meeting-historical-sync:${data.workspaceId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MEETING_HISTORICAL_SYNC].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MEETING_HISTORICAL_SYNC].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MEETING_HISTORICAL_SYNC].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MEETING_HISTORICAL_SYNC].expireInSeconds,
  });

  log.info(
    { jobId, workspaceId: data.workspaceId, requestedBy: data.requestedBy, windowDays: data.windowDays },
    "Meeting historical sync job enqueued",
  );
  return jobId;
}

export async function enqueueMeetingExtract(
  data: MeetingExtractJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MEETING_EXTRACT, data, {
    singletonKey: `meeting-extract:${data.workspaceId}:${data.meetingId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MEETING_EXTRACT].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MEETING_EXTRACT].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MEETING_EXTRACT].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MEETING_EXTRACT].expireInSeconds,
  });

  log.info({ jobId, meetingId: data.meetingId }, "Meeting extract job enqueued");
  return jobId;
}

export async function enqueueMeetingDigest(
  data: MeetingDigestJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MEETING_DIGEST, data, {
    singletonKey: `meeting-digest:${data.workspaceId}:${data.meetingId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MEETING_DIGEST].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MEETING_DIGEST].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MEETING_DIGEST].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MEETING_DIGEST].expireInSeconds,
  });

  log.info({ jobId, meetingId: data.meetingId }, "Meeting digest job enqueued");
  return jobId;
}

export async function enqueueMeetingObligationSync(
  data: MeetingObligationSyncJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.MEETING_OBLIGATION_SYNC, data, {
    singletonKey: `meeting-obligation-sync:${data.workspaceId}:${data.meetingId}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.MEETING_OBLIGATION_SYNC].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.MEETING_OBLIGATION_SYNC].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.MEETING_OBLIGATION_SYNC].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.MEETING_OBLIGATION_SYNC].expireInSeconds,
  });

  log.info({ jobId, meetingId: data.meetingId }, "Meeting obligation sync job enqueued");
  return jobId;
}
