import { eventBus } from "./eventBus.js";
import type {
  FollowUpResolutionReason,
  FollowUpResolutionScope,
  FollowUpSeriousness,
} from "../types/database.js";

export type FollowUpAlertType =
  | "follow_up_opened"
  | "follow_up_high_priority"
  | "follow_up_due"
  | "follow_up_acknowledged"
  | "follow_up_escalated"
  | "follow_up_resolved"
  | "follow_up_dismissed"
  | "follow_up_snoozed";

export type FollowUpAlertChangeType =
  | "created"
  | "updated"
  | "acknowledged"
  | "escalated"
  | "reopened"
  | "severity_changed"
  | "due"
  | "resolved"
  | "dismissed"
  | "snoozed";

function toAttentionItemId(itemId: string): string {
  return `follow-up:${itemId}`;
}

export function emitFollowUpAlert(input: {
  workspaceId: string;
  channelId: string;
  followUpItemId: string;
  alertType: FollowUpAlertType;
  changeType: FollowUpAlertChangeType;
  seriousness: FollowUpSeriousness;
  sourceMessageTs: string;
  threadTs?: string | null;
  summary?: string | null;
  resolutionReason?: FollowUpResolutionReason | null;
  engagementScope?: FollowUpResolutionScope | null;
  lastEngagementAt?: string | null;
}): void {
  eventBus.createAndPublish("alert_triggered", input.workspaceId, input.channelId, {
    alertType: input.alertType,
    attentionItemId: toAttentionItemId(input.followUpItemId),
    followUpItemId: input.followUpItemId,
    changeType: input.changeType,
    seriousness: input.seriousness,
    sourceMessageTs: input.sourceMessageTs,
    threadTs: input.threadTs ?? null,
    summary: input.summary ?? null,
    resolutionReason: input.resolutionReason ?? null,
    engagementScope: input.engagementScope ?? null,
    lastEngagementAt: input.lastEngagementAt ?? null,
  });
}
