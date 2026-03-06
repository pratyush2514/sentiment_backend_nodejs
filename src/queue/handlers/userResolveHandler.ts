import { fetchAndCacheFromSlack } from "../../services/userProfiles.js";
import { logger } from "../../utils/logger.js";
import type { UserResolveJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "userResolve" });

export async function handleUserResolve(
  jobs: Job<UserResolveJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, userId } = job.data;
    log.debug({ jobId: job.id, userId }, "Processing user resolve job");

    const profile = await fetchAndCacheFromSlack(workspaceId, userId);

    if (profile) {
      log.debug(
        { jobId: job.id, userId, displayName: profile.display_name },
        "User resolve complete",
      );
    } else {
      log.warn({ jobId: job.id, userId }, "User resolve returned null");
    }
  }
}
