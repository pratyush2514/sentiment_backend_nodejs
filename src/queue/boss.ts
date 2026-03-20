import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { TARGET_MESSAGE_COUNT } from "../constants.js";
import { markQueueRuntimeState } from "../services/runtimeState.js";
import { logger } from "../utils/logger.js";
import { handleLLMAnalyze } from "./handlers/analyzeHandler.js";
import { handleBackfill } from "./handlers/backfillHandler.js";
import { handleChannelDiscovery } from "./handlers/channelDiscoveryHandler.js";
import { handleMessageIngest } from "./handlers/messageHandler.js";
import { handleThreadReconcile } from "./handlers/reconcileHandler.js";
import { handleSummaryRollup } from "./handlers/rollupHandler.js";
import { handleUserResolve } from "./handlers/userResolveHandler.js";
import { JOB_NAMES, QUEUE_CONFIG } from "./jobTypes.js";
import type {
  BackfillJob,
  MessageIngestJob,
  UserResolveJob,
  ThreadReconcileJob,
  LLMAnalyzeJob,
  SummaryRollupJob,
  ChannelDiscoveryJob,
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
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
    queueRuntimeState = {
      started: false,
      workersRegistered: false,
    };
    markQueueRuntimeState({
      queueStarted: false,
      workersRegistered: false,
    });
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
