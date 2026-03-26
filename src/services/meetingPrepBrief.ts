/**
 * Pre-Meeting Prep Brief
 *
 * Before a scheduled meeting, generates a summary of:
 * - Last meeting summary + unresolved items
 * - Slack activity since last meeting (sentiment shifts, blockers)
 * - Open obligations with status
 * - Channel health trajectory
 *
 * Delivered as a DM to meeting participants or as a dashboard card.
 */

import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { computeChannelHealth, type ChannelHealthScore } from "./analyticsEngine.js";

const log = logger.child({ service: "meetingPrepBrief" });

export interface PrepBriefItem {
  type: "overdue_obligation" | "open_obligation" | "sentiment_shift" | "unresolved_follow_up" | "recent_decision" | "last_meeting_summary";
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  sourceUrl?: string;
}

export interface MeetingPrepBrief {
  meetingTitle: string | null;
  channelId: string;
  channelName: string | null;
  channelHealth: ChannelHealthScore | null;
  items: PrepBriefItem[];
  generatedAt: string;
}

/**
 * Generate a pre-meeting prep brief for a channel.
 * Can be called on-demand (dashboard) or before a scheduled meeting.
 */
export async function generatePrepBrief(
  workspaceId: string,
  channelId: string,
  meetingTitle?: string | null,
): Promise<MeetingPrepBrief> {
  const now = new Date();
  const items: PrepBriefItem[] = [];

  const [channel, channelHealth] = await Promise.all([
    db.getChannel(workspaceId, channelId),
    computeChannelHealth(workspaceId, channelId).catch(() => null),
  ]);

  // 1. Last meeting summary
  try {
    const meetings = await db.listMeetingsForChannel(workspaceId, channelId, 1);
    if (meetings.length > 0) {
      const lastMeeting = meetings[0];
      const summaryText = lastMeeting.fathom_summary
        ? lastMeeting.fathom_summary.slice(0, 300)
        : "No summary available";
      items.push({
        type: "last_meeting_summary",
        title: `Last call: ${lastMeeting.title ?? "Untitled"}`,
        detail: summaryText,
        severity: "info",
        sourceUrl: lastMeeting.share_url ?? undefined,
      });
    }
  } catch {
    // Meeting tables may not exist
  }

  // 2. Overdue meeting obligations
  try {
    const { obligations } = await db.listMeetingObligations(workspaceId, {
      channelId,
      status: "open",
      limit: 20,
    });

    const overdue = obligations.filter((o) => o.due_date && new Date(o.due_date) < now);
    const open = obligations.filter((o) => !o.due_date || new Date(o.due_date) >= now);

    for (const ob of overdue) {
      const daysOverdue = Math.ceil((now.getTime() - new Date(ob.due_date!).getTime()) / (24 * 60 * 60 * 1000));
      items.push({
        type: "overdue_obligation",
        title: ob.title,
        detail: `${ob.owner_name ?? "Unassigned"} — ${daysOverdue} day(s) overdue`,
        severity: daysOverdue > 3 ? "critical" : "warning",
      });
    }

    for (const ob of open.slice(0, 5)) {
      items.push({
        type: "open_obligation",
        title: ob.title,
        detail: `${ob.owner_name ?? "Unassigned"}${ob.due_date ? ` — due ${new Date(ob.due_date).toLocaleDateString()}` : ""}`,
        severity: "info",
      });
    }
  } catch {
    // Non-fatal
  }

  // 3. Unresolved follow-ups in this channel
  try {
    const followUps = await db.listOpenFollowUpItems(workspaceId, 50);
    const channelFollowUps = followUps.filter((f) => f.channel_id === channelId);
    const overdueFollowUps = channelFollowUps.filter(
      (f) => f.due_at && new Date(f.due_at) < now,
    );

    if (overdueFollowUps.length > 0) {
      items.push({
        type: "unresolved_follow_up",
        title: `${overdueFollowUps.length} overdue Slack follow-up(s)`,
        detail: overdueFollowUps
          .slice(0, 3)
          .map((f) => f.summary ?? "Untitled request")
          .join("; "),
        severity: overdueFollowUps.length >= 3 ? "critical" : "warning",
      });
    }
  } catch {
    // Non-fatal
  }

  // 4. Channel health trajectory
  if (channelHealth && channelHealth.trajectory === "degrading") {
    items.push({
      type: "sentiment_shift",
      title: "Sentiment trending down",
      detail: channelHealth.drivers[0]?.description ?? "Channel sentiment has degraded compared to last week",
      severity: "warning",
    });
  }

  // 5. Recent decisions from channel state
  try {
    const channelState = await db.getChannelState(workspaceId, channelId);
    const decisions = channelState?.key_decisions_json ?? [];
    const recentDecisions = decisions.slice(-3);
    for (const decision of recentDecisions) {
      const decisionText = typeof decision === "string" ? decision : (decision as { text?: string })?.text ?? String(decision);
      items.push({
        type: "recent_decision",
        title: "Recent decision",
        detail: decisionText.slice(0, 200),
        severity: "info",
      });
    }
  } catch {
    // Non-fatal
  }

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  log.info(
    { workspaceId, channelId, itemCount: items.length, meetingTitle },
    "Pre-meeting prep brief generated",
  );

  return {
    meetingTitle: meetingTitle ?? null,
    channelId,
    channelName: channel?.name ?? null,
    channelHealth,
    items,
    generatedAt: now.toISOString(),
  };
}
