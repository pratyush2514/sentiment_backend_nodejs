import { runBackfillTier1 } from "../../services/backfill.js";
import { eventBus } from "../../services/eventBus.js";
import { logger } from "../../utils/logger.js";
import type { BackfillTier1Job } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "backfillTier1" });

export async function handleBackfillTier1(jobs: Job<BackfillTier1Job>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, reason } = job.data;
    log.info({ jobId: job.id, channelId, reason }, "Processing backfill tier 1");
    try {
      await runBackfillTier1(workspaceId, channelId, reason);

      eventBus.createAndPublish("channel_status_changed", workspaceId, channelId, {
        newStatus: "ready",
      });

      log.info({ jobId: job.id, channelId }, "Backfill tier 1 complete");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.error({ jobId: job.id, channelId, error: errMsg }, "Backfill tier 1 failed");

      eventBus.createAndPublish("channel_status_changed", workspaceId, channelId, {
        newStatus: "failed",
      });

      throw err;
    }
  }
}
