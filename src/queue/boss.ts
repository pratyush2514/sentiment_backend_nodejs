import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { handleLLMAnalyze } from "./handlers/analyzeHandler.js";
import { handleBackfill } from "./handlers/backfillHandler.js";
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
} from "./jobTypes.js";

const log = logger.child({ service: "pgBoss" });

let boss: PgBoss | null = null;

export async function startQueue(): Promise<PgBoss> {
  boss = new PgBoss({
    connectionString: config.DATABASE_URL, // Direct connection for LISTEN/NOTIFY
    schema: "pgboss",
    monitorIntervalSeconds: 5,
  });

  boss.on("error", (err: Error) => {
    log.error({ err }, "pg-boss error");
  });

  await boss.start();
  log.info("pg-boss started");

  // Create queues (pg-boss v12 requires explicit queue creation)
  await boss.createQueue(JOB_NAMES.BACKFILL);
  await boss.createQueue(JOB_NAMES.MESSAGE_INGEST);
  await boss.createQueue(JOB_NAMES.USER_RESOLVE);
  await boss.createQueue(JOB_NAMES.THREAD_RECONCILE);
  await boss.createQueue(JOB_NAMES.LLM_ANALYZE);
  await boss.createQueue(JOB_NAMES.SUMMARY_ROLLUP);
  log.info("Queues created");

  // Register handlers
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

  log.info("Job handlers registered");
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

  const jobId = await boss.send(JOB_NAMES.LLM_ANALYZE, data, {
    singletonKey: `llm:${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.LLM_ANALYZE].expireInSeconds,
  });

  log.info({ jobId, channelId: data.channelId, triggerType: data.triggerType }, "LLM analyze job enqueued");
  return jobId;
}

export async function enqueueSummaryRollup(
  data: SummaryRollupJob,
): Promise<string | null> {
  if (!boss) throw new Error("Queue not started");

  const jobId = await boss.send(JOB_NAMES.SUMMARY_ROLLUP, data, {
    singletonKey: `rollup:${data.workspaceId}:${data.channelId}:${data.threadTs ?? "channel"}`,
    retryLimit: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryLimit,
    retryDelay: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryDelay,
    retryBackoff: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].retryBackoff,
    expireInSeconds: QUEUE_CONFIG[JOB_NAMES.SUMMARY_ROLLUP].expireInSeconds,
  });

  log.info({ jobId, channelId: data.channelId, rollupType: data.rollupType }, "Summary rollup job enqueued");
  return jobId;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
    log.info("pg-boss stopped");
  }
}

export function getQueue(): PgBoss | null {
  return boss;
}
