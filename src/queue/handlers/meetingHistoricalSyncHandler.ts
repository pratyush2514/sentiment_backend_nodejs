import * as db from "../../db/queries.js";
import {
  fetchMeetingDetails,
  getMeetingIdentifier,
} from "../../services/fathomClient.js";
import { backfillHistoricalFathomLinks } from "../../services/fathomLinkDetector.js";
import { logger } from "../../utils/logger.js";
import { enqueueMeetingIngest } from "../boss.js";
import type { MeetingHistoricalSyncJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ service: "meetingHistoricalSyncHandler" });

export async function handleMeetingHistoricalSync(
  jobs: Job<MeetingHistoricalSyncJob>[],
): Promise<void> {
  for (const job of jobs) {
    await processMeetingHistoricalSync(job.data);
  }
}

async function processMeetingHistoricalSync(
  job: MeetingHistoricalSyncJob,
): Promise<void> {
  const { workspaceId, windowDays, requestedBy } = job;
  let discoveredCount = 0;
  let importedCount = 0;

  log.info(
    { workspaceId, windowDays, requestedBy },
    "Processing historical Fathom sync",
  );

  await db.markFathomHistoricalSyncRunning(workspaceId, windowDays);

  try {
    const createdAfter = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchedMeetings = await fetchMeetingDetails(workspaceId, {
      createdAfter,
    });

    const historicalLinkBackfill = await backfillHistoricalFathomLinks(
      workspaceId,
      windowDays,
      { prefetchedMeetings: fetchedMeetings },
    );

    const fathomCallIds = Array.from(
      new Set(
        fetchedMeetings
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object",
          )
          .map((item) => getMeetingIdentifier(item))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    discoveredCount = fathomCallIds.length;
    importedCount = historicalLinkBackfill.importQueuedCount;
    const existingCallIds = await db.listExistingMeetingCallIds(
      workspaceId,
      fathomCallIds,
    );

    for (const fathomCallId of fathomCallIds) {
      if (existingCallIds.has(fathomCallId)) {
        continue;
      }

      const jobId = await enqueueMeetingIngest({
        workspaceId,
        fathomCallId,
        source: "refetch",
        importMode: "historical",
      });

      if (jobId) {
        importedCount += 1;
      }
    }

    await db.completeFathomHistoricalSync(workspaceId, {
      windowDays,
      discoveredCount,
      importedCount,
    });

    log.info(
      {
        workspaceId,
        windowDays,
        requestedBy,
        discoveredCount,
        importedCount,
        slackLinkBackfillScannedMessages:
          historicalLinkBackfill.scannedMessageCount,
        slackLinkBackfillUniqueLinks:
          historicalLinkBackfill.uniqueShareLinkCount,
      },
      "Historical Fathom sync completed",
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    await db.failFathomHistoricalSync(workspaceId, {
      windowDays,
      discoveredCount,
      importedCount,
      lastError: errMsg,
    });
    log.error(
      { workspaceId, windowDays, requestedBy, err: errMsg },
      "Historical Fathom sync failed",
    );
    throw err;
  }
}
