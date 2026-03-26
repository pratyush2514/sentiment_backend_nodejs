import { config } from "../config.js";
import * as db from "../db/queries.js";
import { enqueueMeetingHistoricalSync, getQueue } from "../queue/boss.js";
import { JOB_NAMES } from "../queue/jobTypes.js";
import { logger } from "../utils/logger.js";
import type { MeetingHistoricalSyncJob } from "../queue/jobTypes.js";
import type { FathomConnectionRow } from "../types/database.js";
import type { JobWithMetadata } from "pg-boss";

const log = logger.child({ service: "fathomHistoricalSyncRecovery" });

function getHistoricalSyncLeaseStart(connection: FathomConnectionRow): Date {
  return connection.historical_sync_started_at ?? connection.updated_at;
}

function getHistoricalSyncLeaseAgeMs(connection: FathomConnectionRow): number {
  return Date.now() - getHistoricalSyncLeaseStart(connection).getTime();
}

function getJobAgeMs(job: JobWithMetadata<unknown>): number {
  const reference = job.startedOn ?? job.createdOn;
  return Date.now() - reference.getTime();
}

function getRecoveryErrorMessage(reason: string): string {
  return `historical_sync_stalled:${reason}`;
}

export function isHistoricalSyncLeaseStale(
  connection: FathomConnectionRow,
): boolean {
  if (
    connection.historical_sync_status !== "queued" &&
    connection.historical_sync_status !== "running"
  ) {
    return false;
  }

  return (
    getHistoricalSyncLeaseAgeMs(connection) >=
    config.FATHOM_HISTORICAL_SYNC_STALE_MINUTES * 60_000
  );
}

export async function recoverHistoricalSyncLease(input: {
  workspaceId: string;
  connection: FathomConnectionRow;
  requestedBy: MeetingHistoricalSyncJob["requestedBy"];
  reason: string;
}): Promise<{
  recovered: boolean;
  connection: FathomConnectionRow | null;
  error: string | null;
}> {
  if (!isHistoricalSyncLeaseStale(input.connection)) {
    return {
      recovered: false,
      connection: input.connection,
      error: null,
    };
  }

  const queue = getQueue();
  const staleThresholdMs = config.FATHOM_HISTORICAL_SYNC_STALE_MINUTES * 60_000;
  const activeJobs = queue
    ? (await queue.findJobs(JOB_NAMES.MEETING_HISTORICAL_SYNC)).filter((job) => {
      return (
        (job.data as Record<string, unknown>)?.workspaceId === input.workspaceId &&
        ["created", "retry", "active"].includes(job.state)
      );
    })
    : [];

  const freshJobs = activeJobs.filter((job) => getJobAgeMs(job) < staleThresholdMs);
  if (freshJobs.length > 0) {
    return {
      recovered: false,
      connection: input.connection,
      error: null,
    };
  }

  if (queue) {
    for (const job of activeJobs) {
      await queue.cancel(JOB_NAMES.MEETING_HISTORICAL_SYNC, job.id);
    }
  }

  const recoveryError = getRecoveryErrorMessage(input.reason);
  await db.failFathomHistoricalSync(input.workspaceId, {
    windowDays: input.connection.historical_sync_window_days,
    discoveredCount: input.connection.historical_sync_discovered_count,
    importedCount: input.connection.historical_sync_imported_count,
    lastError: recoveryError,
  });

  const queuedConnection = await db.queueFathomHistoricalSync(
    input.workspaceId,
    input.connection.historical_sync_window_days,
  );

  if (!queuedConnection) {
    return {
      recovered: false,
      connection: await db.getFathomConnection(input.workspaceId),
      error: recoveryError,
    };
  }

  try {
    await enqueueMeetingHistoricalSync({
      workspaceId: input.workspaceId,
      windowDays: input.connection.historical_sync_window_days,
      requestedBy: input.requestedBy,
    });

    const latestConnection = await db.getFathomConnection(input.workspaceId);
    log.warn(
      {
        workspaceId: input.workspaceId,
        requestedBy: input.requestedBy,
        reason: input.reason,
      },
      "Recovered stale historical Fathom sync lease",
    );
    return {
      recovered: true,
      connection: latestConnection ?? queuedConnection,
      error: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    await db.failFathomHistoricalSync(input.workspaceId, {
      windowDays: input.connection.historical_sync_window_days,
      lastError: errMsg,
    });
    return {
      recovered: false,
      connection: await db.getFathomConnection(input.workspaceId),
      error: errMsg,
    };
  }
}
