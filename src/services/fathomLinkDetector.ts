import { config } from "../config.js";
import * as db from "../db/queries.js";
import { enqueueMeetingIngest } from "../queue/boss.js";
import { logger } from "../utils/logger.js";
import {
  fetchMeetingByShareUrl,
} from "./fathomClient.js";
import {
  cleanMeetingText,
  extractMeetingSummaryText,
  extractShareIdFromUrl,
  getMeetingIdentifier,
  getMeetingShareUrl,
  toIsoString,
  truncateMeetingText,
} from "./fathomMeetingUtils.js";
import { fetchMeetingFromSharePage } from "./fathomSharePage.js";
import { recordIntelligenceDegradation } from "./intelligenceTruth.js";
import { resumeMeetingPipeline } from "./meetingPipeline.js";
import { getSlackClient } from "./slackClientFactory.js";

const log = logger.child({ service: "fathomLinkDetector" });

// Match Fathom video share URLs like:
// https://fathom.video/share/sDf2CmxbBJZJrn9PKwp8zHPysLs1Xysy
// https://fathom.video/share/a9e4kLDQCxiE9SE_uzP8mk6zGs-eS7xE
const FATHOM_SHARE_URL_PATTERN = /https?:\/\/fathom\.video\/share\/([a-zA-Z0-9_-]+)/g;

interface DetectFathomLinksOptions {
  suppressSlackReplies?: boolean;
  prefetchedMeetingsByShareUrl?: Map<string, Record<string, unknown>>;
  importMode?: "live" | "historical";
}

/**
 * Detect Fathom video share URLs in a Slack message.
 * If found, check if the meeting is already stored and only link on an exact
 * URL match. We intentionally avoid heuristic re-linking here because a shared
 * Fathom URL is strong evidence for one meeting, not for broader channel rules.
 */
export async function detectFathomLinks(
  workspaceId: string,
  channelId: string,
  messageText: string,
  userId: string,
  messageTs?: string,
  options: DetectFathomLinksOptions = {},
): Promise<{ matchedShareUrlCount: number; importQueuedCount: number }> {
  if (!config.FATHOM_ENABLED) {
    return { matchedShareUrlCount: 0, importQueuedCount: 0 };
  }

  const matches = [...messageText.matchAll(FATHOM_SHARE_URL_PATTERN)];
  if (matches.length === 0) {
    return { matchedShareUrlCount: 0, importQueuedCount: 0 };
  }

  let importQueuedCount = 0;
  const importMode = options.importMode ?? "live";

  for (const match of matches) {
    const shareUrl = match[0];
    const shareId = match[1];
    log.info(
      { workspaceId, channelId, shareId, userId },
      "Fathom share URL detected in Slack message",
    );

    const knownMeeting = await db.getMeetingByExternalUrl(workspaceId, shareUrl);

    if (knownMeeting) {
      // Meeting already ingested — post instant summary as thread reply
      if (!options.suppressSlackReplies) {
        await postInstantMeetingSummary(
          workspaceId,
          channelId,
          knownMeeting.id,
          messageTs,
        );
      }

      const shouldPromoteToLive =
        importMode === "live" &&
        knownMeeting.import_mode !== "live";
      const shouldLinkChannel = !knownMeeting.channel_id;

      if (shouldLinkChannel || shouldPromoteToLive) {
        const channelLink = await db.getMeetingChannelLinkByChannelId(workspaceId, channelId);
        await db.updateMeetingChannelId(workspaceId, knownMeeting.id, channelId, {
          digestEnabled: channelLink?.digest_enabled ?? true,
          trackingEnabled: channelLink?.tracking_enabled ?? true,
          importMode,
        });
      }

      if (importMode === "live" && (shouldLinkChannel || shouldPromoteToLive)) {
        await resumeMeetingPipeline(workspaceId, knownMeeting.id);
      }
      continue;
    }

    const fetchedMeeting =
      options.prefetchedMeetingsByShareUrl?.get(shareUrl) ??
      await fetchMeetingByShareUrl(workspaceId, shareUrl);
    if (fetchedMeeting) {
      const fathomCallId = getMeetingIdentifier(fetchedMeeting);
      if (fathomCallId) {
        const jobId = await enqueueMeetingIngest({
          workspaceId,
          fathomCallId,
          source: "refetch",
          importMode,
          channelIdHint: channelId,
          payload: fetchedMeeting,
        });
        if (jobId) {
          importQueuedCount += 1;
        }
        if (!options.suppressSlackReplies) {
          await postFetchedMeetingSummary(
            workspaceId,
            channelId,
            fetchedMeeting,
            messageTs,
          );
        }
        continue;
      }
    }

    const sharedLinkMeeting = await fetchMeetingFromSharePage(shareUrl, {
      fallbackStartedAt: slackTsToIso(messageTs),
    });
    if (sharedLinkMeeting) {
      const syntheticCallId = `share:${shareId}`;
      const jobId = await enqueueMeetingIngest({
        workspaceId,
        fathomCallId: syntheticCallId,
        source: "shared_link",
        importMode,
        channelIdHint: channelId,
        payload: sharedLinkMeeting,
      });
      if (jobId) {
        importQueuedCount += 1;
      }
      if (!options.suppressSlackReplies) {
        await postFetchedMeetingSummary(
          workspaceId,
          channelId,
          sharedLinkMeeting,
          messageTs,
        );
      }
      continue;
    }

    await recordIntelligenceDegradation({
      workspaceId,
      channelId,
      scope: "meeting",
      eventType: "fathom_channel_link_missing",
      severity: "low",
      details: {
        shareId,
        shareUrl,
        reason: "no_exact_meeting_match_for_shared_url",
      },
    });
  }

  return {
    matchedShareUrlCount: matches.length,
    importQueuedCount,
  };
}

export async function backfillHistoricalFathomLinks(
  workspaceId: string,
  windowDays: number,
  options?: {
    prefetchedMeetings?: unknown[];
  },
): Promise<{
  scannedMessageCount: number;
  uniqueShareLinkCount: number;
  importQueuedCount: number;
}> {
  const messages = await db.listMessagesWithFathomLinksInWindow(
    workspaceId,
    windowDays,
  );
  const shareUrlIndex = buildMeetingShareUrlIndex(options?.prefetchedMeetings ?? []);
  const dedupedLinks = new Set<string>();
  let importQueuedCount = 0;

  for (const message of messages) {
    const shareUrls = extractFathomShareUrls(message.text);
    const newShareUrls = shareUrls.filter((shareUrl) => {
      const key = `${message.channel_id}:${shareUrl}`;
      if (dedupedLinks.has(key)) {
        return false;
      }
      dedupedLinks.add(key);
      return true;
    });

    if (newShareUrls.length === 0) {
      continue;
    }

    const result = await detectFathomLinks(
      workspaceId,
      message.channel_id,
      newShareUrls.join("\n"),
      message.user_id,
      message.ts,
      {
        suppressSlackReplies: true,
        prefetchedMeetingsByShareUrl: shareUrlIndex,
        importMode: "historical",
      },
    );
    importQueuedCount += result.importQueuedCount;
  }

  return {
    scannedMessageCount: messages.length,
    uniqueShareLinkCount: dedupedLinks.size,
    importQueuedCount,
  };
}

async function postFetchedMeetingSummary(
  workspaceId: string,
  channelId: string,
  meeting: Record<string, unknown>,
  messageTs?: string,
): Promise<void> {
  try {
    const parts: string[] = [];
    const title = String(meeting.title ?? meeting.meetingTitle ?? "Meeting");
    parts.push(`📋 *Meeting Summary: ${title}*`);

    const startedAt =
      toIsoString(meeting.recording_start_time) ??
      toIsoString(meeting.recordingStartTime);
    const endedAt =
      toIsoString(meeting.recording_end_time) ??
      toIsoString(meeting.recordingEndTime);
    const durationSeconds =
      typeof meeting.durationSeconds === "number" && Number.isFinite(meeting.durationSeconds)
        ? Math.round(meeting.durationSeconds)
        : typeof meeting.duration_seconds === "number" && Number.isFinite(meeting.duration_seconds)
          ? Math.round(meeting.duration_seconds)
          : null;
    const durationStr =
      startedAt && endedAt
        ? `${Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000)} min`
        : durationSeconds
          ? `${Math.max(1, Math.round(durationSeconds / 60))} min`
          : "";

    const participants = (
      meeting.calendar_invitees ??
      meeting.calendarInvitees ??
      []
    ) as Array<Record<string, unknown>>;
    const meta = [
      durationStr,
      `${participants.length} participant${participants.length !== 1 ? "s" : ""}`,
    ]
      .filter(Boolean)
      .join(" · ");
    if (meta) parts.push(meta);

    const summary = extractFetchedMeetingSummary(meeting);
    if (summary) {
      parts.push(`\n${truncateMeetingText(summary, 400)}`);
    }

    const actionItems = (
      meeting.action_items ??
      meeting.actionItems ??
      []
    ) as Array<Record<string, unknown>>;
    if (actionItems.length > 0) {
      parts.push(`\n✅ *${actionItems.length} action item${actionItems.length !== 1 ? "s" : ""}:*`);
      for (const item of actionItems.slice(0, 3)) {
        const assigneeRecord =
          typeof item.assignee === "object" && item.assignee
            ? (item.assignee as Record<string, unknown>)
            : null;
        const owner = typeof assigneeRecord?.name === "string" && assigneeRecord.name
          ? `${assigneeRecord.name} →`
          : "•";
        const itemText = String(item.text ?? item.description ?? "Action item");
        parts.push(`  ${owner} ${itemText}`);
      }
      if (actionItems.length > 3) {
        parts.push(`  _...and ${actionItems.length - 3} more_`);
      }
    }

    parts.push(
      isSharedLinkFallbackMeeting(meeting)
        ? "\n_Importing shared-link meeting context into PulseBoard for this channel._"
        : "\n_Importing full meeting context into PulseBoard for this channel._",
    );

    const slack = await getSlackClient(workspaceId);
    await slack.postSlackMessage({
      channelId,
      text: parts.join("\n"),
      threadTs: messageTs,
    });

    log.info(
      { workspaceId, channelId, messageTs, title },
      "Posted fetched Fathom meeting preview in thread",
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn(
      { workspaceId, channelId, err: errMsg },
      "Failed to post fetched Fathom meeting preview",
    );
  }
}

/**
 * Post an instant meeting summary as a thread reply when someone shares a Fathom link.
 */
async function postInstantMeetingSummary(
  workspaceId: string,
  channelId: string,
  meetingId: string,
  messageTs?: string,
): Promise<void> {
  try {
    const meeting = await db.getMeeting(workspaceId, meetingId);
    if (!meeting) return;

    const obligations = await db.getMeetingObligations(workspaceId, meetingId);
    const actionItems = obligations.filter((o) =>
      ["action_item", "commitment", "next_step"].includes(o.obligation_type),
    );
    const decisions = obligations.filter((o) => o.obligation_type === "decision");
    const risks = obligations.filter((o) => o.obligation_type === "risk");

    // Build a concise thread reply
    const parts: string[] = [];

    parts.push(`📋 *Meeting Summary: ${meeting.title}*`);

    const durationStr = meeting.duration_seconds
      ? `${Math.round(meeting.duration_seconds / 60)} min`
      : "";
    const participantCount = (meeting.participants_json ?? []).length;
    const meta = [durationStr, `${participantCount} participant${participantCount !== 1 ? "s" : ""}`]
      .filter(Boolean)
      .join(" · ");
    if (meta) parts.push(meta);

    // Brief summary (first 300 chars of cleaned summary)
    if (meeting.fathom_summary) {
      const cleaned = cleanMeetingText(meeting.fathom_summary);
      const brief = truncateMeetingText(cleaned, 400);
      parts.push(`\n${brief}`);
    }

    if (actionItems.length > 0) {
      parts.push(`\n✅ *${actionItems.length} action item${actionItems.length !== 1 ? "s" : ""}:*`);
      for (const item of actionItems.slice(0, 3)) {
        const owner = item.owner_name ? `${item.owner_name} →` : "•";
        parts.push(`  ${owner} ${item.title}`);
      }
      if (actionItems.length > 3) {
        parts.push(`  _...and ${actionItems.length - 3} more_`);
      }
    }

    if (decisions.length > 0) {
      parts.push(`\n📋 *${decisions.length} decision${decisions.length !== 1 ? "s" : ""}:*`);
      for (const d of decisions.slice(0, 2)) {
        parts.push(`  • ${d.title}`);
      }
    }

    if (risks.length > 0) {
      parts.push(`\n⚠️ *${risks.length} risk signal${risks.length !== 1 ? "s" : ""}*`);
    }

    const text = parts.join("\n");

    const slack = await getSlackClient(workspaceId);
    await slack.postSlackMessage({
      channelId,
      text,
      threadTs: messageTs,
    });

    log.info(
      { workspaceId, channelId, meetingId, messageTs },
      "Posted instant meeting summary in thread",
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn(
      { workspaceId, channelId, meetingId, err: errMsg },
      "Failed to post instant meeting summary",
    );
  }
}

function extractFetchedMeetingSummary(meeting: Record<string, unknown>): string | null {
  const summary = extractMeetingSummaryText(meeting);
  return summary ? cleanMeetingText(summary) : null;
}

function buildMeetingShareUrlIndex(
  meetings: unknown[],
): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const meeting of meetings) {
    if (!meeting || typeof meeting !== "object") {
      continue;
    }
    const record = meeting as Record<string, unknown>;
    const shareUrl = getMeetingShareUrl(record);
    if (shareUrl) {
      index.set(shareUrl, record);
    }
  }
  return index;
}

function extractFathomShareUrls(messageText: string): string[] {
  return [...messageText.matchAll(FATHOM_SHARE_URL_PATTERN)].map((match) => match[0]);
}

function slackTsToIso(messageTs?: string): string | null {
  const parsed = Number.parseFloat(messageTs ?? "");
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function isSharedLinkFallbackMeeting(meeting: Record<string, unknown>): boolean {
  const source =
    (typeof meeting.meetingSource === "string" ? meeting.meetingSource : null) ??
    (typeof meeting.meeting_source === "string" ? meeting.meeting_source : null);
  if (source === "shared_link") {
    return true;
  }

  const shareUrl = getMeetingShareUrl(meeting);
  const shareId = extractShareIdFromUrl(shareUrl);
  return typeof meeting.recordingId !== "number" && typeof meeting.recording_id !== "string" && Boolean(shareId);
}
