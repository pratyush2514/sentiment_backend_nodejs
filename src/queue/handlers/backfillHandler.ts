import { runBackfill } from "../../services/backfill.js";
import { logger } from "../../utils/logger.js";
import type { BackfillJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "backfill" });

export async function handleBackfill(jobs: Job<BackfillJob>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, reason } = job.data;
    log.info({ jobId: job.id, channelId, reason }, "Processing backfill job");

    await runBackfill(workspaceId, channelId, reason);

    log.info({ jobId: job.id, channelId }, "Backfill job complete");
  }
}
