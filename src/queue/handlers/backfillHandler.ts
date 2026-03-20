import { runBackfill } from "../../services/backfill.js";
import { eventBus } from "../../services/eventBus.js";
import { logger } from "../../utils/logger.js";
import type { BackfillJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "backfill" });

export async function handleBackfill(jobs: Job<BackfillJob>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, reason } = job.data;
    log.info({ jobId: job.id, channelId, reason }, "Processing backfill job");

    try {
      await runBackfill(workspaceId, channelId, reason);

      eventBus.createAndPublish("channel_status_changed", workspaceId, channelId, {
        newStatus: "ready",
      });

      log.info({ jobId: job.id, channelId }, "Backfill job complete");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.error({ jobId: job.id, channelId, error: errMsg }, "Backfill job failed");

      eventBus.createAndPublish("channel_status_changed", workspaceId, channelId, {
        newStatus: "failed",
      });

      // Re-throw so pg-boss can retry
      throw err;
    }
  }
}
