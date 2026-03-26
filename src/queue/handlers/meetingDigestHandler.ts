import * as db from "../../db/queries.js";
import { recordIntelligenceDegradation } from "../../services/intelligenceTruth.js";
import { postMeetingDigest } from "../../services/meetingDigest.js";
import { logger } from "../../utils/logger.js";
import { enqueueMeetingObligationSync } from "../boss.js";
import type { MeetingDigestJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ service: "meetingDigestHandler" });

export async function handleMeetingDigest(jobs: Job<MeetingDigestJob>[]): Promise<void> {
  for (const job of jobs) {
    await processMeetingDigest(job.data);
  }
}

async function processMeetingDigest(job: MeetingDigestJob): Promise<void> {
  const { workspaceId, meetingId, channelId } = job;

  log.info({ workspaceId, meetingId, channelId }, "Processing meeting digest");

  const meeting = await db.getMeeting(workspaceId, meetingId);
  if (!meeting) {
    log.warn({ workspaceId, meetingId }, "Meeting not found for digest");
    return;
  }

  if (!meeting.digest_enabled) {
    log.info({ workspaceId, meetingId }, "Meeting digest disabled, skipping");
    return;
  }

  if (meeting.import_mode === "historical") {
    log.info({ workspaceId, meetingId }, "Historical meeting digest suppressed, skipping");
    return;
  }

  // Already posted or claimed by another worker?
  if (meeting.digest_message_ts) {
    log.info({ workspaceId, meetingId }, "Meeting digest already posted or claimed, skipping");
    return;
  }

  // Atomic claim — only one worker wins
  const claimed = await db.claimMeetingDigestSlot(workspaceId, meetingId);
  if (!claimed) {
    log.info({ workspaceId, meetingId }, "Meeting digest claim lost to another worker, skipping");
    return;
  }

  const obligations = await db.getMeetingObligations(workspaceId, meetingId);

  // Get risk signals from extraction (stored in obligations with type "risk")
  const persistedRiskSignals = (meeting.risk_signals_json ?? [])
    .map((signal) => {
      if (
        signal &&
        typeof signal === "object" &&
        "signal" in signal &&
        typeof signal.signal === "string"
      ) {
        return signal.signal;
      }
      return null;
    })
    .filter((signal): signal is string => Boolean(signal));
  const obligationRiskSignals = obligations
    .filter((o) => o.obligation_type === "risk")
    .map((o) => o.title);
  const riskSignals = [...new Set([...persistedRiskSignals, ...obligationRiskSignals])];

  try {
    const { messageTs } = await postMeetingDigest(
      workspaceId,
      channelId,
      meeting,
      obligations,
      riskSignals,
    );

    await db.updateMeetingDigest(workspaceId, meetingId, messageTs);
    if (meeting.tracking_enabled) {
      await enqueueMeetingObligationSync({ workspaceId, meetingId });
    }

    log.info(
      { workspaceId, meetingId, channelId, messageTs, obligationCount: obligations.length },
      "Meeting digest posted successfully",
    );
  } catch (err) {
    // Release claim so retry can work
    await db.releaseMeetingDigestClaim(workspaceId, meetingId);

    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, meetingId, channelId, err: errMsg }, "Failed to post meeting digest");

    await recordIntelligenceDegradation({
      workspaceId,
      channelId,
      scope: "meeting",
      eventType: "fathom_digest_failed",
      severity: "medium",
      details: {
        meetingId,
        channelId,
        error: errMsg,
      },
    });

    await db.updateMeetingProcessingStatus(workspaceId, meetingId, "failed", errMsg);
    throw err;
  }
}
