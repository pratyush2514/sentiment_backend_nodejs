import { logger } from "../utils/logger.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { MeetingRow, MeetingObligationRow } from "../types/database.js";

const log = logger.child({ service: "meetingDigest" });

/**
 * Build Slack Block Kit blocks for a meeting digest.
 * Hybrid approach: Fathom summary as main body + PulseBoard intelligence footer.
 */
export function buildDigestBlocks(
  meeting: MeetingRow,
  obligations: MeetingObligationRow[],
  riskSignals: string[] = [],
): unknown[] {
  const blocks: unknown[] = [];

  // Header
  const durationStr = meeting.duration_seconds
    ? `${Math.round(meeting.duration_seconds / 60)} min`
    : "Unknown duration";
  const participantCount = (meeting.participants_json ?? []).length;

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📞 ${meeting.title}`,
      emoji: true,
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `⏱ ${durationStr} · ${participantCount} participant${participantCount !== 1 ? "s" : ""} · ${formatDate(meeting.started_at)}`,
      },
    ],
  });

  // Fathom summary (cleaned for Slack readability)
  if (meeting.fathom_summary) {
    const cleanedSummary = cleanFathomSummary(meeting.fathom_summary);
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateMarkdown(cleanedSummary, 2800),
      },
    });
  }

  // PulseBoard Intelligence section
  const actionItems = obligations.filter((o) => ["action_item", "commitment", "next_step"].includes(o.obligation_type));
  const decisions = obligations.filter((o) => o.obligation_type === "decision");
  const risks = obligations.filter((o) => o.obligation_type === "risk");

  const hasPulseboardContent = actionItems.length > 0 || decisions.length > 0 || risks.length > 0 || riskSignals.length > 0;

  if (hasPulseboardContent) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📌 PulseBoard Intelligence*",
      },
    });

    if (meeting.meeting_sentiment) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Sentiment: *${meeting.meeting_sentiment}*`,
          },
        ],
      });
    }

    // Risk signals (deduplicated)
    const allRisks = [...new Set([
      ...riskSignals,
      ...risks.map((r) => r.title),
    ])];
    if (allRisks.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*⚠️ Risk Signals*\n${allRisks.map((r) => `• ${r}`).join("\n")}`,
        },
      });
    }

    // Action items
    if (actionItems.length > 0) {
      const itemLines = actionItems.map((item) => {
        const owner = item.owner_user_id
          ? `<@${item.owner_user_id}>`
          : item.owner_name ?? "Unassigned";
        const due = item.due_date ? ` (due ${formatShortDate(item.due_date)})` : "";
        return `• ${owner} → ${item.title}${due}`;
      });

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*✅ Tracked Items (${actionItems.length})*\n${itemLines.join("\n")}`,
        },
      });
    }

    // Decisions
    if (decisions.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📋 Decisions*\n${decisions.map((d) => `• ${d.title}`).join("\n")}`,
        },
      });
    }
  }

  // Footer with clickable Fathom link
  const trackedCount = actionItems.length;
  const footerParts = [];

  const fathomUrl = meeting.share_url ?? meeting.recording_url;
  if (fathomUrl) {
    footerParts.push(`<${fathomUrl}|🔗 View Recording in Fathom>`);
  } else if (meeting.fathom_call_id) {
    footerParts.push(`<https://fathom.video|🔗 View in Fathom>`);
  }

  if (trackedCount > 0) {
    footerParts.push(`${trackedCount} item${trackedCount !== 1 ? "s" : ""} being tracked`);
  }

  if (footerParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: footerParts.join(" · "),
        },
      ],
    });
  }

  return blocks;
}

/**
 * Post meeting digest to a Slack channel.
 */
export async function postMeetingDigest(
  workspaceId: string,
  channelId: string,
  meeting: MeetingRow,
  obligations: MeetingObligationRow[],
  riskSignals: string[] = [],
): Promise<{ messageTs: string; threadTs?: string }> {
  const slack = await getSlackClient(workspaceId);
  const blocks = buildDigestBlocks(meeting, obligations, riskSignals);

  const fallbackText = `📞 Meeting digest: ${meeting.title}`;

  const result = await slack.postSlackMessage({
    channelId,
    text: fallbackText,
    blocks,
  });

  const messageTs = result.ts ?? "";

  log.info(
    { workspaceId, channelId, meetingId: meeting.id, messageTs },
    "Meeting digest posted to Slack",
  );

  return { messageTs };
}

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(date: string): string {
  try {
    const d = new Date(date);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return date;
  }
}

function truncateMarkdown(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Clean Fathom summary markdown for Slack:
 * - Strip inline markdown links [text](url) → keep just the text
 * - Convert markdown bold **text** → Slack bold *text*
 * - Convert ### headings → bold lines
 * - Remove empty brackets and leftover artifacts
 */
function cleanFathomSummary(raw: string): string {
  let text = raw;

  // Remove markdown links: [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Remove bare URLs on their own line (Fathom timestamp links)
  text = text.replace(/^\s*\(https?:\/\/[^)]+\)\s*$/gm, "");
  text = text.replace(/\(https?:\/\/fathom\.video[^)]*\)/g, "");

  // Convert markdown bold **text** to Slack bold *text*
  text = text.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert ### heading to bold (Slack doesn't support headings)
  text = text.replace(/^###\s+(.+)$/gm, "\n*$1*");

  // Clean up multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}
