import { config } from "../../config.js";
import * as db from "../../db/queries.js";
import { fetchMeetingByCallId } from "../../services/fathomClient.js";
import {
  extractMeetingSummaryText,
  toIsoString,
} from "../../services/fathomMeetingUtils.js";
import { recordIntelligenceDegradation } from "../../services/intelligenceTruth.js";
import { resolveChannelForMeeting } from "../../services/meetingChannelResolver.js";
import { sanitizeForExternalUse } from "../../services/privacyFilter.js";
import { logger } from "../../utils/logger.js";
import { enqueueMeetingExtract } from "../boss.js";
import type {
  FathomActionItem,
  FathomParticipant,
  MeetingRow,
  MeetingSource,
} from "../../types/database.js";
import type { MeetingIngestJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ service: "meetingIngestHandler" });

export async function handleMeetingIngest(jobs: Job<MeetingIngestJob>[]): Promise<void> {
  for (const job of jobs) {
    await processMeetingIngest(job.data);
  }
}

async function processMeetingIngest(job: MeetingIngestJob): Promise<void> {
  const {
    workspaceId,
    fathomCallId,
    source,
    importMode = "live",
    channelIdHint,
    payload,
  } = job;

  log.info(
    { workspaceId, fathomCallId, source, importMode },
    "Processing meeting ingest",
  );

  let existing = await db.getMeetingByFathomCallId(workspaceId, fathomCallId);
  const incomingMeetingSource = toMeetingSource(source);
  if (
    existing &&
    (existing.processing_status === "completed" ||
      existing.processing_status === "duplicate") &&
    (source === "shared_link" || existing.meeting_source !== "shared_link")
  ) {
    log.info({ workspaceId, fathomCallId }, "Meeting already processed, skipping");
    return;
  }

  const data = await resolveMeetingPayload(
    workspaceId,
    fathomCallId,
    source,
    payload,
    existing,
  );
  if (!data) {
    log.warn({ workspaceId, fathomCallId, source }, "Meeting payload unavailable for ingest");
    return;
  }

  const parsedMeeting = parseMeetingPayload(data, existing);
  const {
    title,
    startedAt,
    endedAt,
    durationSeconds,
    participants,
    recordedByEmail,
    fathomSummary,
    fathomActionItems,
    fathomHighlights,
    recordingUrl,
    shareUrl,
    transcriptText,
  } = parsedMeeting;

  if (
    !existing &&
    shareUrl &&
    incomingMeetingSource !== "shared_link"
  ) {
    const provisionalMeeting = await db.getMeetingByExternalUrl(workspaceId, shareUrl);
    if (
      provisionalMeeting &&
      provisionalMeeting.meeting_source === "shared_link" &&
      provisionalMeeting.fathom_call_id.startsWith("share:")
    ) {
      await db.promoteSharedLinkMeeting(workspaceId, provisionalMeeting.id, {
        fathomCallId,
        meetingSource: incomingMeetingSource,
        importMode,
      });
      existing = await db.getMeetingByFathomCallId(workspaceId, fathomCallId);
    }
  }

  const hintedChannel = channelIdHint
    ? await resolveHintedChannel(workspaceId, channelIdHint)
    : null;

  // Duplicate detection: check if a different recording of the same call exists
  // (happens when "Single Bot per Meeting" is OFF in Fathom and multiple team members record)
  const participantEmails = new Set(
    participants
      .map((participant) => participant.email?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
  );

  if (participantEmails.size > 0) {
    const duplicate = await detectDuplicateMeeting(
      workspaceId,
      fathomCallId,
      new Date(startedAt),
      participantEmails,
    );
    if (duplicate) {
      log.info(
        { workspaceId, fathomCallId, duplicateOf: duplicate.fathom_call_id, duplicateMeetingId: duplicate.id },
        "Duplicate meeting detected (same participants + time window), skipping",
      );

      await db.upsertMeeting({
        workspaceId,
        fathomCallId,
        meetingSource: incomingMeetingSource,
        channelId: duplicate.channel_id ?? hintedChannel?.channelId ?? null,
        title,
        startedAt,
        endedAt,
        durationSeconds,
        participantsJson: participants,
        fathomSummary,
        fathomActionItemsJson: fathomActionItems,
        fathomHighlightsJson: fathomHighlights,
        recordingUrl,
        shareUrl,
        transcriptText,
        processingStatus: "duplicate",
        digestEnabled:
          duplicate.digest_enabled ??
          hintedChannel?.digestEnabled ??
          null,
        trackingEnabled:
          duplicate.tracking_enabled ??
          hintedChannel?.trackingEnabled ??
          null,
        duplicateOfMeetingId: duplicate.id,
        importMode,
      });
      return;
    }
  }

  const resolvedChannel =
    hintedChannel ??
    await resolveChannelForMeeting(workspaceId, {
      title,
      participants,
      recorderEmail: recordedByEmail,
      summary: fathomSummary,
    });

  // Upsert meeting
  const shouldRunExtraction =
    resolvedChannel &&
    (incomingMeetingSource !== "shared_link" || importMode === "live");

  const meeting = await db.upsertMeeting({
    workspaceId,
    fathomCallId,
    meetingSource: incomingMeetingSource,
    channelId: resolvedChannel?.channelId ?? existing?.channel_id ?? null,
    title,
    startedAt,
    endedAt,
    durationSeconds,
    participantsJson: participants,
    fathomSummary,
    fathomActionItemsJson: fathomActionItems,
    fathomHighlightsJson: fathomHighlights,
    recordingUrl,
    shareUrl,
    transcriptText,
    processingStatus:
      shouldRunExtraction
        ? "extracting"
        : resolvedChannel
          ? "completed"
        : "pending",
    digestEnabled: resolvedChannel?.digestEnabled ?? existing?.digest_enabled ?? null,
    trackingEnabled: resolvedChannel?.trackingEnabled ?? existing?.tracking_enabled ?? null,
    importMode,
  });

  if (resolvedChannel) {
    if (!shouldRunExtraction) {
      log.info(
        {
          workspaceId,
          meetingId: meeting.id,
          channelId: resolvedChannel.channelId,
          fathomCallId,
          matchedBy: resolvedChannel.matchedBy,
        },
        "Meeting ingested and linked to channel without extraction side effects",
      );
    } else {
      await enqueueMeetingExtract({
        workspaceId,
        meetingId: meeting.id,
      });

      log.info(
        {
          workspaceId,
          meetingId: meeting.id,
          channelId: resolvedChannel.channelId,
          fathomCallId,
          matchedBy: resolvedChannel.matchedBy,
        },
        "Meeting ingested and linked to channel, extraction enqueued",
      );
    }
  } else {
    // Store as unlinked — no digest, but still save the data
    await db.updateMeetingProcessingStatus(workspaceId, meeting.id, "pending");
    await recordIntelligenceDegradation({
      workspaceId,
      channelId: "",
      scope: "meeting",
      eventType: "fathom_channel_link_missing",
      severity: "low",
      details: {
        meetingId: meeting.id,
        fathomCallId,
        title,
        participantDomains: [...new Set(participants.map((p) => p.domain).filter(Boolean))],
      },
    });

    log.info(
      { workspaceId, meetingId: meeting.id, fathomCallId },
      "Meeting ingested but no channel rule matched — stored as unlinked",
    );
  }
}

async function resolveHintedChannel(
  workspaceId: string,
  channelId: string,
): Promise<{
  channelId: string;
  digestEnabled: boolean;
  trackingEnabled: boolean;
  matchedBy: "shared_link";
}> {
  const channelLink = await db.getMeetingChannelLinkByChannelId(
    workspaceId,
    channelId,
  );

  return {
    channelId,
    digestEnabled: channelLink?.digest_enabled ?? true,
    trackingEnabled: channelLink?.tracking_enabled ?? true,
    matchedBy: "shared_link",
  };
}

async function resolveMeetingPayload(
  workspaceId: string,
  fathomCallId: string,
  source: MeetingIngestJob["source"],
  payload?: Record<string, unknown>,
  existing?: MeetingRow | null,
): Promise<Record<string, unknown> | null> {
  if (source === "shared_link" && payload) {
    return payload;
  }

  const payloadHasStartTime = payload
    ? hasResolvableMeetingStartTime(payload, existing ?? null)
    : false;

  if (source === "webhook") {
    if (payload && payloadHasStartTime) {
      return payload;
    }

    const meeting = await fetchMeetingByCallId(workspaceId, fathomCallId);
    if (meeting) {
      const merged = payload ? { ...meeting, ...payload } : meeting;
      if (hasResolvableMeetingStartTime(merged, existing ?? null)) {
        return merged;
      }
    }

    throw new Error("meeting_payload_unavailable_from_webhook");
  }

  if (source === "refetch") {
    if (payload && payloadHasStartTime) {
      return payload;
    }

    const meeting = await fetchMeetingByCallId(workspaceId, fathomCallId);
    if (meeting) {
      const merged = payload ? { ...meeting, ...payload } : meeting;
      if (hasResolvableMeetingStartTime(merged, existing ?? null)) {
        return merged;
      }
    }

    await recordIntelligenceDegradation({
      workspaceId,
      channelId: "",
      scope: "meeting",
      eventType: "fathom_fetch_failed",
      severity: "medium",
      details: {
        fathomCallId,
        reason: "meeting_not_found_during_refetch",
      },
    });
    throw new Error("meeting_payload_unavailable_from_refetch");
  }

  return null;
}

function toMeetingSource(source: MeetingIngestJob["source"]): MeetingSource {
  switch (source) {
    case "webhook":
      return "webhook";
    case "shared_link":
      return "shared_link";
    default:
      return "api";
  }
}

function parseMeetingPayload(
  data: Record<string, unknown>,
  existing: MeetingRow | null,
): {
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  participants: FathomParticipant[];
  recordedByEmail: string | null;
  fathomSummary: string | null;
  fathomActionItems: FathomActionItem[];
  fathomHighlights: unknown[];
  recordingUrl: string | null;
  shareUrl: string | null;
  transcriptText: string | null;
} {
  const title = String(data.title ?? data.meeting_title ?? existing?.title ?? "Untitled Meeting");
  const startedAtRaw =
    toIsoString(data.recording_start_time) ??
    toIsoString(data.recordingStartTime) ??
    toIsoString(data.scheduled_start_time) ??
    toIsoString(data.scheduledStartTime) ??
    existing?.started_at?.toISOString() ??
    null;

  if (!startedAtRaw) {
    throw new Error("missing_meeting_start_time");
  }

  const endedAtRaw =
    toIsoString(data.recording_end_time) ??
    toIsoString(data.recordingEndTime) ??
    toIsoString(data.scheduled_end_time) ??
    toIsoString(data.scheduledEndTime) ??
    existing?.ended_at?.toISOString() ??
    null;

  const calendarInvitees = (
    data.calendar_invitees ??
    data.calendarInvitees ??
    []
  ) as Array<Record<string, unknown>>;
  const participants: FathomParticipant[] = calendarInvitees.map((inv) => ({
    name: (inv.name ?? inv.email ?? "Unknown") as string,
    email: (inv.email ?? null) as string | null,
    domain: (inv.domain ?? extractDomain(inv.email as string | null)) as string | null,
  }));

  const recordedBy = (
    data.recorded_by ??
    data.recordedBy ??
    null
  ) as Record<string, unknown> | null;
  const recordedByEmail =
    recordedBy && typeof recordedBy.email === "string"
      ? recordedBy.email
      : null;
  if (recordedByEmail) {
    const recorderAlreadyIncluded = participants.some(
      (participant) => participant.email?.toLowerCase() === recordedByEmail.toLowerCase(),
    );
    if (!recorderAlreadyIncluded) {
      participants.push({
        name: (recordedBy?.name ?? recordedByEmail) as string,
        email: recordedByEmail,
        domain: extractDomain(recordedByEmail),
      });
    }
  }

  const fathomSummary = extractMeetingSummaryText(
    data,
    existing?.fathom_summary ?? null,
  );

  const rawActionItems = (
    data.action_items ??
    data.actionItems ??
    []
  ) as Array<Record<string, unknown>>;
  const fathomActionItems: FathomActionItem[] = rawActionItems.map((item) => ({
    text: (item.text ?? item.description ?? "") as string,
    assignee:
      typeof item.assignee === "string"
        ? item.assignee
        : ((item.assignee as Record<string, unknown> | null)?.name ?? null) as string | null,
  }));

  const rawTranscript = (data.transcript ?? []) as Array<Record<string, unknown>>;
  const transcriptText = buildTranscriptText(rawTranscript);

  const fathomHighlights = (data.highlights ?? []) as unknown[];
  const recordingUrl =
    (typeof data.url === "string" ? data.url : null) ??
    (typeof data.recording_url === "string" ? data.recording_url : null) ??
    (typeof data.recordingUrl === "string" ? data.recordingUrl : null) ??
    existing?.recording_url ??
    null;
  const shareUrl =
    (typeof data.share_url === "string" ? data.share_url : null) ??
    (typeof data.shareUrl === "string" ? data.shareUrl : null) ??
    existing?.share_url ??
    null;
  const durationSecondsFromPayload = parseDurationSeconds(
    data.duration_seconds ?? data.durationSeconds ?? null,
  );

  return {
    title,
    startedAt: startedAtRaw,
    endedAt: endedAtRaw,
    durationSeconds:
      durationSecondsFromPayload ?? computeDurationSeconds(startedAtRaw, endedAtRaw),
    participants,
    recordedByEmail,
    fathomSummary,
    fathomActionItems,
    fathomHighlights,
    recordingUrl,
    shareUrl,
    transcriptText,
  };
}

function hasResolvableMeetingStartTime(
  data: Record<string, unknown>,
  existing: MeetingRow | null,
): boolean {
  return Boolean(
    toIsoString(data.recording_start_time) ??
    toIsoString(data.recordingStartTime) ??
    toIsoString(data.scheduled_start_time) ??
    toIsoString(data.scheduledStartTime) ??
    existing?.started_at?.toISOString() ??
    null,
  );
}

function buildTranscriptText(
  rawTranscript: Array<Record<string, unknown>>,
): string | null {
  if (rawTranscript.length === 0 || config.PRIVACY_MODE === "skip") {
    return null;
  }

  const lines = rawTranscript.map((entry) => {
    const speaker = entry.speaker as Record<string, unknown> | null;
    const speakerName = (speaker?.display_name ?? speaker?.displayName ?? "Unknown") as string;
    const timestamp = (entry.timestamp ?? "") as string;
    const text = (entry.text ?? "") as string;
    const line = `[${timestamp}] ${speakerName}: ${text}`;

    if (config.PRIVACY_MODE === "redact") {
      const sanitized = sanitizeForExternalUse(line, "redact");
      return sanitized.action === "redacted" ? sanitized.text : line;
    }

    return line;
  });

  return lines.join("\n");
}

function computeDurationSeconds(
  startedAt: string,
  endedAt: string | null,
): number | null {
  if (!endedAt) return null;
  try {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    return Math.round((end - start) / 1000);
  } catch {
    return null;
  }
}

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function extractDomain(email: string | null): string | null {
  if (!email) return null;
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

/**
 * Detect if a meeting is a duplicate of an already-processed meeting.
 * This happens when multiple team members record the same call with Fathom
 * (i.e., "Single Bot per Meeting" setting is OFF).
 *
 * Checks: meetings within a 30-minute window with 80%+ participant overlap.
 */
async function detectDuplicateMeeting(
  workspaceId: string,
  currentFathomCallId: string,
  startedAt: Date,
  participantEmails: Set<string>,
): Promise<MeetingRow | null> {
  const DUPLICATE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const OVERLAP_THRESHOLD = 0.8; // 80% participant overlap

  // Get recent meetings within the time window
  const { meetings } = await db.listMeetings(workspaceId, { limit: 20 });

  for (const meeting of meetings) {
    // Skip the same recording (different fathom_call_id means different recording)
    if (meeting.fathom_call_id === currentFathomCallId) continue;

    // Skip if not within time window
    const timeDiff = Math.abs(new Date(meeting.started_at).getTime() - startedAt.getTime());
    if (timeDiff > DUPLICATE_WINDOW_MS) continue;

    // Skip if not already processed (only dedupe against completed meetings)
    if (meeting.processing_status !== "completed" && meeting.processing_status !== "extracting" && meeting.processing_status !== "digesting") continue;

    // Check participant overlap
    const existingEmails = new Set(
      (meeting.participants_json ?? [])
        .map((p) => p.email?.toLowerCase())
        .filter((e): e is string => Boolean(e)),
    );

    if (existingEmails.size === 0 || participantEmails.size === 0) continue;

    const overlapCount = [...participantEmails].filter((e) => existingEmails.has(e)).length;
    const overlapRatio = overlapCount / Math.max(participantEmails.size, existingEmails.size);

    if (overlapRatio >= OVERLAP_THRESHOLD) {
      return meeting;
    }
  }

  return null;
}
