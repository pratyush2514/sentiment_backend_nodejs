import { discoverChannels } from "../../services/channelDiscovery.js";
import { logger } from "../../utils/logger.js";
import type { ChannelDiscoveryJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "channelDiscovery" });

export async function handleChannelDiscovery(jobs: Job<ChannelDiscoveryJob>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, reason } = job.data;
    log.info({ jobId: job.id, workspaceId, reason }, "Starting channel discovery");

    const result = await discoverChannels(workspaceId);

    log.info(
      { jobId: job.id, workspaceId, discovered: result.discovered, newlyTracked: result.newlyTracked },
      "Channel discovery complete",
    );
  }
}
