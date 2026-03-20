import * as db from "../db/queries.js";
import { resolveSurfaceAnalysis } from "./analysisSurface.js";
import {
  resolveConversationImportance,
  tierAllowsLeadershipHeuristics,
  tierAllowsResolvedHistory,
} from "./conversationImportance.js";
import { scoreFollowUpText } from "./followUpMonitor.js";
import { buildRoleDirectory } from "./roleInference.js";
import { isManagerRelevantThreadInsight } from "./threadInsightPolicy.js";
import type {
  ConversationType,
  FollowUpResolutionReason,
  FollowUpResolutionScope,
  FollowUpWorkflowState,
  UserRole,
} from "../types/database.js";

/**
 * Replace raw `<@USERID>` mentions with display names for human-readable text.
 */
function resolveMentions(text: string, nameMap: Map<string, string>): string {
  return text.replace(/<@([A-Z0-9]+)>/gi, (_match, userId: string) => {
    const name = nameMap.get(userId);
    return name ? `@${name}` : `@${userId}`;
  });
}

export type AttentionKind =
  | "reply_needed"
  | "follow_up_due"
  | "leadership_instruction"
  | "sentiment_risk"
  | "thread_escalation";

export type AttentionGroup =
  | "needs_reply"
  | "acknowledged"
  | "escalated"
  | "sentiment_risk"
  | "resolved_recently";

export type AttentionState = "open" | "acknowledged" | "escalated" | "resolved";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  group: AttentionGroup;
  resolutionState: AttentionState;
  severity: "low" | "medium" | "high";
  priorityScore: number;
  conversationType: ConversationType;
  channelId: string;
  channelName: string;
  actorUserId?: string | null;
  actorName?: string | null;
  sourceMessageTs: string;
  threadTs?: string | null;
  title: string;
  message: string;
  whyThisMatters: string;
  expectedResponderIds: string[];
  expectedResponderNames: string[];
  workflowState?: FollowUpWorkflowState | null;
  primaryResponderIds: string[];
  primaryResponderNames: string[];
  escalationResponderIds: string[];
  escalationResponderNames: string[];
  resolvedViaEscalation?: boolean;
  primaryMissedSla?: boolean;
  acknowledgedAt?: string | null;
  ignoredScore?: number;
  visibilityAfter?: string | null;
  lastStateChangedAt: string;
  dueAt?: string | null;
  createdAt: string;
  contextHref: string;
  followUpItemId?: string | null;
  resolutionReason?: FollowUpResolutionReason | null;
  engagementScope?: FollowUpResolutionScope | null;
  lastEngagementAt?: string | null;
  metadata?: Record<string, unknown>;
  messageIntent?: string | null;
  urgencyDimensions?: {
    isActionable: boolean;
    isBlocking: boolean;
    urgencyLevel: string;
  } | null;
}

function severityWeight(severity: "low" | "medium" | "high"): number {
  switch (severity) {
    case "high":
      return 30;
    case "medium":
      return 18;
    default:
      return 8;
  }
}

function roleWeight(role: UserRole | "unknown"): number {
  switch (role) {
    case "client":
      return 20;
    case "senior":
      return 18;
    case "worker":
      return 10;
    case "observer":
      return 4;
    default:
      return 0;
  }
}

function intentWeight(intent: string | null): number {
  switch (intent) {
    case "blocker":
      return 16;
    case "escalation":
      return 14;
    case "request":
      return 10;
    case "question":
      return 8;
    case "decision":
      return 6;
    case "commitment":
      return 4;
    default:
      return 0;
  }
}

function conversationTypeWeight(type: ConversationType): number {
  switch (type) {
    case "dm":
      return 8;
    case "group_dm":
      return 6;
    case "private_channel":
      return 4;
    case "public_channel":
      return 2;
    default:
      return 0;
  }
}

function toIso(ts: string | Date | null | undefined): string {
  if (!ts) return new Date().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  const direct = new Date(ts);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const parsed = Number.parseFloat(ts);
  if (Number.isFinite(parsed)) return new Date(parsed * 1000).toISOString();
  return new Date().toISOString();
}

function contextHref(channelId: string, sourceMessageTs: string, threadTs?: string | null): string {
  const anchor = `message-${sourceMessageTs.replace(".", "-")}`;
  return threadTs
    ? `/dashboard/channels/${channelId}/threads/${threadTs}?messageTs=${sourceMessageTs}#${anchor}`
    : `/dashboard/channels/${channelId}?conversation=1&messageTs=${sourceMessageTs}#${anchor}`;
}

function resolveExpectedResponders(
  ownerIds: string[] | null | undefined,
  seniorIds: string[] | null | undefined,
  roleMap: Map<string, Awaited<ReturnType<typeof buildRoleDirectory>>[number]>,
  requesterUserId?: string | null,
): string[] {
  const explicit = [...new Set([...(ownerIds ?? []), ...(seniorIds ?? [])])];
  if (!requesterUserId) {
    return explicit;
  }

  const filteredExplicit = explicit.filter((userId) => userId !== requesterUserId);
  if (filteredExplicit.length > 0) {
    return filteredExplicit;
  }

  const requesterRole = roleMap.get(requesterUserId)?.effectiveRole ?? "unknown";
  return [...roleMap.entries()]
    .filter(([userId, entry]) => {
      if (userId === requesterUserId) return false;
      if (requesterRole === "client") {
        return entry.effectiveRole === "worker" || entry.effectiveRole === "senior";
      }
      if (requesterRole === "senior") {
        return entry.effectiveRole === "worker";
      }
      if (requesterRole === "worker") {
        return entry.effectiveRole === "senior";
      }
      return entry.effectiveRole === "worker" || entry.effectiveRole === "senior";
    })
    .map(([userId]) => userId);
}

function isConversationVisible(
  conversationType: ConversationType,
  privacyOptIn: boolean,
  muted: boolean,
): boolean {
  if (muted) {
    return false;
  }

  if (conversationType === "public_channel") {
    return true;
  }

  return privacyOptIn;
}

function allowsLowValueThreadInsight(insight: {
  thread_state: string;
  operational_risk: string;
  surface_priority: string;
}): boolean {
  return (
    insight.thread_state === "blocked" ||
    insight.thread_state === "escalated" ||
    insight.operational_risk === "high" ||
    insight.surface_priority === "high"
  );
}

function allowsLowValueSentimentAlert(alert: {
  escalation_risk: string;
}): boolean {
  return alert.escalation_risk === "high";
}

function resolvedFollowUpTitle(reason: FollowUpResolutionReason | null): string {
  switch (reason) {
    case "reaction_ack":
      return "Acknowledged by reaction";
    case "reply":
      return "Resolved by reply";
    case "requester_ack":
      return "Acknowledged by requester";
    case "natural_conclusion":
      return "Concluded naturally";
    case "manual_done":
      return "Marked done";
    case "manual_dismissed":
      return "Dismissed";
    case "expired":
      return "Expired";
    default:
      return "Resolved follow-up";
  }
}

function resolvedFollowUpSummary(reason: FollowUpResolutionReason | null): string {
  switch (reason) {
    case "reaction_ack":
      return "A reaction acknowledged the request, so PulseBoard closed the reminder.";
    case "reply":
      return "A same-channel reply satisfied the request.";
    case "requester_ack":
      return "The requester acknowledged the outcome and closed the loop.";
    case "natural_conclusion":
      return "The conversation went quiet without strong overdue pressure, so the reminder was closed quietly.";
    case "manual_done":
      return "Someone manually marked this reminder as done.";
    case "manual_dismissed":
      return "Someone manually dismissed this reminder.";
    case "expired":
      return "This reminder aged out automatically.";
    default:
      return "This request was resolved recently and can be used for accountability context.";
  }
}

function workflowGroup(workflowState: FollowUpWorkflowState): AttentionGroup {
  switch (workflowState) {
    case "acknowledged_waiting":
      return "acknowledged";
    case "escalated":
      return "escalated";
    case "resolved":
    case "dismissed":
    case "expired":
      return "resolved_recently";
    default:
      return "needs_reply";
  }
}

function workflowTitle(workflowState: FollowUpWorkflowState): string {
  switch (workflowState) {
    case "acknowledged_waiting":
      return "Acknowledged, waiting on completion";
    case "escalated":
      return "Escalated to senior";
    case "resolved":
      return "Resolved";
    case "dismissed":
      return "Dismissed";
    case "expired":
      return "Quietly concluded";
    default:
      return "Awaiting first reply";
  }
}

export async function listAttentionItems(
  workspaceId: string,
  options: {
    limit?: number;
    channelId?: string | null;
    kind?: AttentionKind | "all";
    group?: AttentionGroup | "all";
    severity?: "low" | "medium" | "high" | "all";
    assigneeUserId?: string | null;
    conversationType?: ConversationType | "all";
    workflowState?: FollowUpWorkflowState | "all";
    resolutionState?: AttentionState | "all";
    ownershipPhase?: "primary" | "escalation" | "all";
    includeHistory?: boolean;
  } = {},
): Promise<AttentionItem[]> {
  const limit = Math.max(10, Math.min(200, options.limit ?? 80));
  const [
    openFollowUps,
    resolvedFollowUps,
    sentimentAlerts,
    recentThreadInsights,
    recentMessages,
    policies,
    roleDirectory,
  ] =
    await Promise.all([
      db.listOpenFollowUpItems(workspaceId, limit),
      db.listRecentlyResolvedFollowUpItems(workspaceId, 20),
      db.getRecentSentimentAlerts(workspaceId, limit),
      db.getRecentThreadInsights(workspaceId, limit),
      db.getRecentWorkspaceTopLevelMessagesEnriched(workspaceId, limit * 2),
      db.listConversationPolicies(workspaceId),
      buildRoleDirectory(workspaceId),
    ]);

  const roleMap = new Map(roleDirectory.map((entry) => [entry.userId, entry]));
  const policyMap = new Map(policies.map((policy) => [policy.channel_id, policy]));
  const openSourceTs = new Set(openFollowUps.map((item) => `${item.channel_id}:${item.source_message_ts}`));

  // Build a userId → displayName map for resolving <@USERID> mentions in text
  const nameMap = new Map<string, string>();
  for (const entry of roleDirectory) {
    nameMap.set(entry.userId, entry.displayName);
  }

  // Batch-fetch analytics for all open follow-ups to enrich priority scoring
  const analyticsBatch = await db.getMessageAnalyticsBatch(
    workspaceId,
    openFollowUps.map((item) => item.source_message_ts),
  );
  const analyticsMap = new Map(analyticsBatch.map((a) => [a.message_ts, a]));
  const coveredThreadIds = new Set(
    recentThreadInsights
      .filter((insight) => insight.surface_priority === "medium" || insight.surface_priority === "high")
      .map((insight) => `${insight.channel_id}:${insight.thread_ts}`),
  );

  const items: AttentionItem[] = [];

  for (const item of openFollowUps) {
    const policy = policyMap.get(item.channel_id);
    const conversationType = policy?.conversation_type ?? "public_channel";
    if (!isConversationVisible(conversationType, policy?.privacy_opt_in ?? false, policy?.muted ?? false)) {
      continue;
    }
    if (policy?.enabled === false) {
      continue;
    }
    const importance = resolveConversationImportance({
      channelName: item.channel_name ?? item.channel_id,
      conversationType,
      clientUserIds: policy?.client_user_ids ?? [],
      importanceTierOverride: policy?.importance_tier_override,
    });
    const requesterRole = roleMap.get(item.requester_user_id)?.effectiveRole ?? "unknown";
    const overdue = new Date(item.due_at).getTime() <= Date.now();
    const analyticsRow = analyticsMap.get(item.source_message_ts);
    const score =
      severityWeight(item.seriousness) +
      roleWeight(requesterRole) +
      intentWeight(analyticsRow?.message_intent ?? null) +
      conversationTypeWeight(conversationType) +
      Math.min(24, item.repeated_ask_count * 4) +
      (item.workflow_state === "escalated" ? 18 : item.workflow_state === "acknowledged_waiting" ? 6 : overdue ? 14 : 0);

    const primaryResponderIds =
      item.primary_responder_ids.length > 0
        ? item.primary_responder_ids
        : resolveExpectedResponders(
            policy?.owner_user_ids ?? [],
            [],
            roleMap,
            item.requester_user_id,
          );
    const escalationResponderIds =
      item.escalation_responder_ids.length > 0
        ? item.escalation_responder_ids
        : resolveExpectedResponders(
            [],
            policy?.senior_user_ids ?? [],
            roleMap,
            item.requester_user_id,
          );
    const ownershipPhase = item.workflow_state === "escalated" ? "escalation" : "primary";
    const expectedResponderIds =
      ownershipPhase === "escalation" && escalationResponderIds.length > 0
        ? escalationResponderIds
        : primaryResponderIds.length > 0
          ? primaryResponderIds
          : escalationResponderIds;
    const expectedResponderNames = expectedResponderIds.map(
      (userId) => roleMap.get(userId)?.displayName ?? userId,
    );
    const primaryResponderNames = primaryResponderIds.map(
      (userId) => roleMap.get(userId)?.displayName ?? userId,
    );
    const escalationResponderNames = escalationResponderIds.map(
      (userId) => roleMap.get(userId)?.displayName ?? userId,
    );
    const group = workflowGroup(item.workflow_state);
    const resolutionState: AttentionState =
      item.workflow_state === "acknowledged_waiting"
        ? "acknowledged"
        : item.workflow_state === "escalated"
          ? "escalated"
          : "open";

    items.push({
      id: `follow-up:${item.id}`,
      kind: item.workflow_state === "escalated" || overdue ? "follow_up_due" : "reply_needed",
      group,
      resolutionState,
      severity: item.seriousness,
      priorityScore: score,
      conversationType,
      channelId: item.channel_id,
      channelName: item.channel_name ?? item.channel_id,
      actorUserId: item.requester_user_id,
      actorName:
        item.requester_display_name ??
        item.requester_real_name ??
        item.requester_user_id,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      title: workflowTitle(item.workflow_state),
      message: resolveMentions(item.source_message_text ?? item.summary ?? "A response appears to be needed.", nameMap),
      whyThisMatters:
        item.workflow_state === "acknowledged_waiting"
          ? "Someone acknowledged the request, but there is still no substantive completion yet."
          : item.workflow_state === "escalated"
            ? "The primary reply window was missed or the request was repeatedly nudged, so this item moved to senior coverage."
            : item.summary || "PulseBoard detected an unresolved request that still expects a response.",
      expectedResponderIds,
      expectedResponderNames,
      workflowState: item.workflow_state,
      primaryResponderIds,
      primaryResponderNames,
      escalationResponderIds,
      escalationResponderNames,
      resolvedViaEscalation: item.resolved_via_escalation,
      primaryMissedSla: item.primary_missed_sla,
      acknowledgedAt: item.acknowledged_at?.toISOString?.() ?? null,
      ignoredScore: item.ignored_score,
      visibilityAfter: item.visibility_after?.toISOString?.() ?? null,
      lastStateChangedAt:
        item.escalated_at?.toISOString?.() ??
        item.acknowledged_at?.toISOString?.() ??
        item.updated_at.toISOString(),
      dueAt: item.due_at?.toISOString?.() ?? toIso(item.due_at),
      createdAt: item.created_at.toISOString(),
      contextHref: contextHref(item.channel_id, item.source_message_ts, item.source_thread_ts),
      followUpItemId: item.id,
      resolutionReason: item.resolution_reason,
      engagementScope: item.resolution_scope,
      lastEngagementAt: item.last_engagement_at?.toISOString?.() ?? null,
      metadata: {
        repeatedAskCount: item.repeated_ask_count,
        alertCount: item.alert_count,
        requesterRole,
        ownershipPhase,
        importanceTier: importance.effectiveImportanceTier,
      },
      messageIntent: analyticsRow?.message_intent ?? null,
      urgencyDimensions: analyticsRow
        ? {
            isActionable: analyticsRow.is_actionable ?? false,
            isBlocking: analyticsRow.is_blocking ?? false,
            urgencyLevel: analyticsRow.urgency_level ?? "none",
          }
        : null,
    });
  }

  for (const insight of recentThreadInsights) {
    const policy = policyMap.get(insight.channel_id);
    const conversationType = policy?.conversation_type ?? "public_channel";
    if (!isConversationVisible(conversationType, policy?.privacy_opt_in ?? false, policy?.muted ?? false)) {
      continue;
    }
    if (policy?.enabled === false) {
      continue;
    }
    const importance = resolveConversationImportance({
      channelName: insight.channel_name ?? insight.channel_id,
      conversationType,
      clientUserIds: policy?.client_user_ids ?? [],
      importanceTierOverride: policy?.importance_tier_override,
    });
    if (!isManagerRelevantThreadInsight({
      threadState: insight.thread_state,
      operationalRisk: insight.operational_risk,
      emotionalTemperature: insight.emotional_temperature,
      surfacePriority: insight.surface_priority,
      openQuestions: insight.open_questions_json,
      crucialMoments: insight.crucial_moments_json,
    })) {
      continue;
    }
    if (
      importance.effectiveImportanceTier === "low_value" &&
      !allowsLowValueThreadInsight(insight)
    ) {
      continue;
    }
    const severity =
      insight.surface_priority === "high" || insight.thread_state === "escalated" || insight.operational_risk === "high"
        ? "high"
        : "medium";
    const expectedResponderIds = resolveExpectedResponders(
      policy?.owner_user_ids ?? [],
      policy?.senior_user_ids ?? [],
      roleMap,
      null,
    );
    items.push({
      id: `thread-insight:${insight.channel_id}:${insight.thread_ts}`,
      kind: "thread_escalation",
      group: "sentiment_risk",
      workflowState: null,
      resolutionState: "open",
      severity,
      priorityScore: severityWeight(severity) + 14,
      conversationType,
      channelId: insight.channel_id,
      channelName: insight.channel_name ?? insight.channel_id,
      actorUserId: null,
      actorName: null,
      sourceMessageTs: insight.last_meaningful_change_ts ?? insight.thread_ts,
      threadTs: insight.thread_ts,
      title:
        insight.thread_state === "blocked"
          ? "Blocked thread requires attention"
          : "Thread escalation detected",
      message: insight.summary,
      whyThisMatters: insight.primary_issue,
      expectedResponderIds,
      expectedResponderNames: expectedResponderIds.map((userId) => roleMap.get(userId)?.displayName ?? userId),
      primaryResponderIds: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        [],
        roleMap,
        null,
      ),
      primaryResponderNames: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        [],
        roleMap,
        null,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      escalationResponderIds: resolveExpectedResponders(
        [],
        policy?.senior_user_ids ?? [],
        roleMap,
        null,
      ),
      escalationResponderNames: resolveExpectedResponders(
        [],
        policy?.senior_user_ids ?? [],
        roleMap,
        null,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      lastStateChangedAt: insight.updated_at.toISOString(),
      dueAt: null,
      createdAt: insight.created_at.toISOString(),
      contextHref: contextHref(
        insight.channel_id,
        insight.last_meaningful_change_ts ?? insight.thread_ts,
        insight.thread_ts,
      ),
      metadata: {
        threadState: insight.thread_state,
        primaryIssue: insight.primary_issue,
        emotionalTemperature: insight.emotional_temperature,
        operationalRisk: insight.operational_risk,
        surfacePriority: insight.surface_priority,
        importanceTier: importance.effectiveImportanceTier,
      },
    });
  }

  for (const alert of sentimentAlerts) {
    if (alert.thread_ts && coveredThreadIds.has(`${alert.channel_id}:${alert.thread_ts}`)) {
      continue;
    }

    const surfaced = resolveSurfaceAnalysis({
      dominantEmotion: alert.dominant_emotion,
      interactionTone: alert.interaction_tone,
      escalationRisk: alert.escalation_risk,
      sarcasmDetected: false,
      messageText: alert.message_text,
    });

    if (
      surfaced.emotion === "neutral" &&
      alert.escalation_risk !== "high" &&
      (surfaced.interactionTone === "corrective" || surfaced.interactionTone === "tense")
    ) {
      continue;
    }

    const policy = policyMap.get(alert.channel_id);
    const conversationType = policy?.conversation_type ?? "public_channel";
    if (!isConversationVisible(conversationType, policy?.privacy_opt_in ?? false, policy?.muted ?? false)) {
      continue;
    }
    const importance = resolveConversationImportance({
      channelName: alert.channel_name ?? alert.channel_id,
      conversationType,
      clientUserIds: policy?.client_user_ids ?? [],
      importanceTierOverride: policy?.importance_tier_override,
    });
    if (
      importance.effectiveImportanceTier === "low_value" &&
      !allowsLowValueSentimentAlert(alert)
    ) {
      continue;
    }
    const kind = alert.thread_ts ? "thread_escalation" : "sentiment_risk";
    const severity = alert.escalation_risk === "high" ? "high" : "medium";
    items.push({
      id: `sentiment:${alert.channel_id}:${alert.message_ts}`,
      kind,
      group: "sentiment_risk",
      workflowState: null,
      resolutionState: "open",
      severity,
      priorityScore: severityWeight(severity) + 10,
      conversationType,
      channelId: alert.channel_id,
      channelName: alert.channel_name ?? alert.channel_id,
      actorUserId: alert.user_id,
      actorName: alert.display_name ?? alert.real_name ?? alert.user_id,
      sourceMessageTs: alert.message_ts,
      threadTs: alert.thread_ts,
      title: kind === "thread_escalation" ? "Thread escalation detected" : "Sentiment risk detected",
      message: resolveMentions(
        surfaced.explanationOverride ??
          alert.message_text ??
          alert.explanation ??
          "Conversation tone needs attention.",
        nameMap,
      ),
      whyThisMatters:
        surfaced.explanationOverride ??
        alert.explanation ??
        "A recent message carries elevated escalation risk and may require intervention.",
      expectedResponderIds: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        policy?.senior_user_ids ?? [],
        roleMap,
        alert.user_id,
      ),
      expectedResponderNames: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        policy?.senior_user_ids ?? [],
        roleMap,
        alert.user_id,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      primaryResponderIds: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        [],
        roleMap,
        alert.user_id,
      ),
      primaryResponderNames: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        [],
        roleMap,
        alert.user_id,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      escalationResponderIds: resolveExpectedResponders(
        [],
        policy?.senior_user_ids ?? [],
        roleMap,
        alert.user_id,
      ),
      escalationResponderNames: resolveExpectedResponders(
        [],
        policy?.senior_user_ids ?? [],
        roleMap,
        alert.user_id,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      lastStateChangedAt: alert.created_at.toISOString(),
      dueAt: null,
      createdAt: alert.created_at.toISOString(),
      contextHref: contextHref(alert.channel_id, alert.message_ts, alert.thread_ts),
      metadata: {
        dominantEmotion: surfaced.emotion,
        interactionTone: surfaced.interactionTone,
        importanceTier: importance.effectiveImportanceTier,
      },
    });
  }

  for (const message of recentMessages) {
    const sender = roleMap.get(message.user_id);
    if (!sender || sender.effectiveRole !== "senior") continue;
    if (message.reply_count > 0) continue;
    if (openSourceTs.has(`${message.channel_id}:${message.ts}`)) continue;
    if (Date.now() - new Date(toIso(message.ts)).getTime() < 15 * 60 * 1000) continue;

    const heuristic = scoreFollowUpText(message.text, 1);
    if (!heuristic.shouldTrack) continue;

    const policy = policyMap.get(message.channel_id);
    if (!isConversationVisible(
      message.conversation_type,
      policy?.privacy_opt_in ?? false,
      policy?.muted ?? false,
    )) {
      continue;
    }
    if (policy?.enabled === false) {
      continue;
    }
    const importance = resolveConversationImportance({
      channelName: message.channel_name ?? message.channel_id,
      conversationType: message.conversation_type,
      clientUserIds: policy?.client_user_ids ?? [],
      importanceTierOverride: policy?.importance_tier_override,
    });
    if (!tierAllowsLeadershipHeuristics(importance.effectiveImportanceTier)) {
      continue;
    }
    const expectedResponderIds = resolveExpectedResponders(
      policy?.owner_user_ids ?? [],
      policy?.senior_user_ids ?? [],
      roleMap,
      message.user_id,
    );
    const expectedResponderNames = expectedResponderIds.map((userId) => roleMap.get(userId)?.displayName ?? userId);
    const severity = heuristic.seriousness === "low" ? "medium" : heuristic.seriousness;
    items.push({
      id: `leadership:${message.channel_id}:${message.ts}`,
      kind: "leadership_instruction",
      group: "needs_reply",
      resolutionState: "open",
      severity,
      priorityScore: severityWeight(severity) + roleWeight("senior") + 12,
      conversationType: message.conversation_type,
      channelId: message.channel_id,
      channelName: message.channel_name ?? message.channel_id,
      actorUserId: message.user_id,
      actorName: sender.displayName,
      sourceMessageTs: message.ts,
      threadTs: message.thread_ts ?? null,
      title: "Senior instruction needs acknowledgement",
      message: resolveMentions(message.text, nameMap),
      whyThisMatters:
        heuristic.summary || "A senior teammate appears to have asked for action without a visible follow-up yet.",
      expectedResponderIds,
      expectedResponderNames,
      workflowState: null,
      primaryResponderIds: expectedResponderIds,
      primaryResponderNames: expectedResponderNames,
      escalationResponderIds: [],
      escalationResponderNames: [],
      lastStateChangedAt: toIso(message.ts),
      dueAt: null,
      createdAt: toIso(message.ts),
      contextHref: contextHref(message.channel_id, message.ts, message.thread_ts),
      resolutionReason: null,
      engagementScope: null,
      lastEngagementAt: null,
      metadata: {
        requesterRole: "senior",
        importanceTier: importance.effectiveImportanceTier,
      },
    });
  }

  for (const item of resolvedFollowUps) {
    const policy = policyMap.get(item.channel_id);
    const conversationType = policy?.conversation_type ?? "public_channel";
    if (!isConversationVisible(conversationType, policy?.privacy_opt_in ?? false, policy?.muted ?? false)) {
      continue;
    }
    const importance = resolveConversationImportance({
      channelName: item.channel_name ?? item.channel_id,
      conversationType,
      clientUserIds: policy?.client_user_ids ?? [],
      importanceTierOverride: policy?.importance_tier_override,
    });
    if (!tierAllowsResolvedHistory(importance.effectiveImportanceTier)) {
      continue;
    }
    items.push({
      id: `resolved:${item.id}`,
      kind: "reply_needed",
      group: "resolved_recently",
      resolutionState: "resolved",
      severity: item.seriousness,
      priorityScore: 1,
      conversationType,
      channelId: item.channel_id,
      channelName: item.channel_name ?? item.channel_id,
      actorUserId: item.requester_user_id,
      actorName:
        item.requester_display_name ??
        item.requester_real_name ??
        item.requester_user_id,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      title: resolvedFollowUpTitle(item.resolution_reason),
      message: resolveMentions(item.source_message_text ?? item.summary ?? "", nameMap),
      whyThisMatters: resolvedFollowUpSummary(item.resolution_reason),
      expectedResponderIds: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        policy?.senior_user_ids ?? [],
        roleMap,
        item.requester_user_id,
      ),
      expectedResponderNames: resolveExpectedResponders(
        policy?.owner_user_ids ?? [],
        policy?.senior_user_ids ?? [],
        roleMap,
        item.requester_user_id,
      ).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      workflowState: item.workflow_state,
      primaryResponderIds: item.primary_responder_ids ?? [],
      primaryResponderNames: (item.primary_responder_ids ?? []).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      escalationResponderIds: item.escalation_responder_ids ?? [],
      escalationResponderNames: (item.escalation_responder_ids ?? []).map((userId) => roleMap.get(userId)?.displayName ?? userId),
      resolvedViaEscalation: item.resolved_via_escalation,
      primaryMissedSla: item.primary_missed_sla,
      acknowledgedAt: item.acknowledged_at?.toISOString?.() ?? null,
      ignoredScore: item.ignored_score,
      visibilityAfter: item.visibility_after?.toISOString?.() ?? null,
      lastStateChangedAt:
        item.resolved_at?.toISOString?.() ??
        item.updated_at.toISOString(),
      dueAt: null,
      createdAt: item.resolved_at?.toISOString?.() ?? item.created_at.toISOString(),
      contextHref: contextHref(item.channel_id, item.source_message_ts, item.source_thread_ts),
      followUpItemId: item.id,
      resolutionReason: item.resolution_reason,
      engagementScope: item.resolution_scope,
      lastEngagementAt: item.last_engagement_at?.toISOString?.() ?? null,
      metadata: {
        importanceTier: importance.effectiveImportanceTier,
      },
    });
  }

  const filtered = items.filter((item) => {
    if (options.channelId && item.channelId !== options.channelId) return false;
    if (options.kind && options.kind !== "all" && item.kind !== options.kind) return false;
    if (options.group && options.group !== "all" && item.group !== options.group) return false;
    if (options.severity && options.severity !== "all" && item.severity !== options.severity) return false;
    if (options.workflowState && options.workflowState !== "all" && item.workflowState !== options.workflowState) {
      return false;
    }
    if (options.resolutionState && options.resolutionState !== "all" && item.resolutionState !== options.resolutionState) {
      return false;
    }
    if (
      options.ownershipPhase &&
      options.ownershipPhase !== "all" &&
      item.metadata?.ownershipPhase !== options.ownershipPhase
    ) {
      return false;
    }
    if (
      options.conversationType &&
      options.conversationType !== "all" &&
      item.conversationType !== options.conversationType
    ) {
      return false;
    }
    if (
      options.assigneeUserId &&
      !item.expectedResponderIds.includes(options.assigneeUserId)
    ) {
      return false;
    }
    if (!options.includeHistory && item.group === "resolved_recently") {
      return false;
    }
    return true;
  });

  return filtered
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return new Date(b.lastStateChangedAt).getTime() - new Date(a.lastStateChangedAt).getTime();
    })
    .slice(0, limit);
}
