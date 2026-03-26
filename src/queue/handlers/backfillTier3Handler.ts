import { runBackfillTier3 } from "../../services/backfill.js";
import { logger } from "../../utils/logger.js";
import type { BackfillTier3Job } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "backfillTier3" });

export async function handleBackfillTier3(jobs: Job<BackfillTier3Job>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, backfillRunId, reason, tier2CoverageOldestTs } = job.data;
    log.info({ jobId: job.id, channelId, backfillRunId, reason }, "Processing backfill tier 3");
    try {
      await runBackfillTier3(workspaceId, channelId, backfillRunId, reason, tier2CoverageOldestTs);
      log.info({ jobId: job.id, channelId }, "Backfill tier 3 complete");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.error({ jobId: job.id, channelId, error: errMsg }, "Backfill tier 3 failed");
      throw err;
    }
  }
}
