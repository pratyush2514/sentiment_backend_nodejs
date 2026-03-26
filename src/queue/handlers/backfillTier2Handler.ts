import { runBackfillTier2 } from "../../services/backfill.js";
import { logger } from "../../utils/logger.js";
import type { BackfillTier2Job } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "backfillTier2" });

export async function handleBackfillTier2(jobs: Job<BackfillTier2Job>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, backfillRunId, reason } = job.data;
    log.info({ jobId: job.id, channelId, backfillRunId, reason }, "Processing backfill tier 2");
    try {
      await runBackfillTier2(workspaceId, channelId, backfillRunId, reason);
      log.info({ jobId: job.id, channelId }, "Backfill tier 2 complete");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.error({ jobId: job.id, channelId, error: errMsg }, "Backfill tier 2 failed");
      throw err;
    }
  }
}
