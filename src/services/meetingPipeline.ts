import * as db from "../db/queries.js";
import {
  enqueueMeetingDigest,
  enqueueMeetingExtract,
  enqueueMeetingObligationSync,
} from "../queue/boss.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "meetingPipeline" });

export async function resumeMeetingPipeline(
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  const meeting = await db.getMeeting(workspaceId, meetingId);
  if (!meeting || !meeting.channel_id) {
    return;
  }

  if (meeting.processing_status === "duplicate") {
    return;
  }

  if (meeting.extraction_status !== "completed") {
    await enqueueMeetingExtract({
      workspaceId,
      meetingId,
    });
    log.info(
      { workspaceId, meetingId, channelId: meeting.channel_id },
      "Resumed meeting pipeline from extraction",
    );
    return;
  }

  if (meeting.import_mode === "historical") {
    log.info(
      { workspaceId, meetingId, channelId: meeting.channel_id },
      "Meeting remains historical after relink; live side effects stay suppressed",
    );
    return;
  }

  if (meeting.digest_enabled && !meeting.digest_message_ts) {
    await enqueueMeetingDigest({
      workspaceId,
      meetingId,
      channelId: meeting.channel_id,
    });
    log.info(
      { workspaceId, meetingId, channelId: meeting.channel_id },
      "Resumed meeting pipeline from digest",
    );
    return;
  }

  if (meeting.tracking_enabled) {
    await enqueueMeetingObligationSync({
      workspaceId,
      meetingId,
    });
    log.info(
      { workspaceId, meetingId, channelId: meeting.channel_id },
      "Resumed meeting pipeline from obligation sync",
    );
  }
}
