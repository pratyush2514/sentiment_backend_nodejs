import * as db from "../../db/queries.js";
import { bridgeObligationsToFollowUps } from "../../services/meetingObligationBridge.js";
import { logger } from "../../utils/logger.js";
import type { MeetingObligationSyncJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ service: "meetingObligationSyncHandler" });

export async function handleMeetingObligationSync(jobs: Job<MeetingObligationSyncJob>[]): Promise<void> {
  for (const job of jobs) {
    await processMeetingObligationSync(job.data);
  }
}

async function processMeetingObligationSync(job: MeetingObligationSyncJob): Promise<void> {
  const { workspaceId, meetingId } = job;

  log.info({ workspaceId, meetingId }, "Processing meeting obligation sync");

  const meeting = await db.getMeeting(workspaceId, meetingId);
  if (!meeting) {
    log.warn({ workspaceId, meetingId }, "Meeting not found for obligation sync");
    return;
  }

  if (!meeting.channel_id) {
    log.warn({ workspaceId, meetingId }, "Meeting has no channel_id, skipping obligation sync");
    return;
  }

  if (!meeting.tracking_enabled) {
    log.info({ workspaceId, meetingId }, "Meeting tracking disabled, skipping obligation sync");
    return;
  }

  if (meeting.import_mode === "historical") {
    log.info({ workspaceId, meetingId }, "Historical meeting follow-up sync suppressed, skipping");
    return;
  }

  const bridgedCount = await bridgeObligationsToFollowUps(
    workspaceId,
    meetingId,
    meeting.channel_id,
    meeting.digest_message_ts,
  );

  log.info(
    { workspaceId, meetingId, channelId: meeting.channel_id, bridgedCount },
    "Meeting obligation sync completed",
  );
}
