import { classifyChannel } from "../../services/channelClassifier.js";
import { logger } from "../../utils/logger.js";
import type { ChannelClassifyJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "channelClassify" });

export async function handleChannelClassify(jobs: Job<ChannelClassifyJob>[]): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, source } = job.data;

    log.info({ workspaceId, channelId, source, jobId: job.id }, "Processing channel classification");

    try {
      const result = await classifyChannel(workspaceId, channelId);

      log.info(
        {
          workspaceId,
          channelId,
          channelType: result.channel_type,
          confidence: result.confidence,
          source: result.classification_source,
          jobSource: source,
        },
        "Channel classification complete",
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.error(
        { workspaceId, channelId, source, err: errMsg },
        "Channel classification failed",
      );
      throw err; // Let pg-boss retry
    }
  }
}
