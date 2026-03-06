import { reconcileChannelThreads } from "../../services/threadReconcile.js";
import { logger } from "../../utils/logger.js";
import type { ThreadReconcileJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "threadReconcile" });

export async function handleThreadReconcile(
  jobs: Job<ThreadReconcileJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId } = job.data;
    log.info({ jobId: job.id, channelId }, "Processing thread reconcile job");

    await reconcileChannelThreads(workspaceId, channelId);

    log.info({ jobId: job.id, channelId }, "Thread reconcile complete");
  }
}
