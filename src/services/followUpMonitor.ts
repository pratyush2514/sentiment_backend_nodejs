import { config } from "../config.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { emitFollowUpAlert } from "./followUpEvents.js";
import { clearFollowUpReminderDms } from "./followUpReminderDms.js";
import { backPropagateFollowUpResolution } from "./meetingObligationBridge.js";
import { buildRoleDirectory } from "./roleInference.js";
import type {
  ConversationType,
  FollowUpItemRow,
  FollowUpRuleRow,
  FollowUpSeriousness,
  FollowUpWorkflowState,
  UserRole,
} from "../types/database.js";

const log = logger.child({ service: "followUpMonitor" });

const REQUEST_PATTERNS = [
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bwill you\b/i,
  /\bplease\b/i,
  /\bneed (you|someone|help|review|input|response|reply|this|that|an update|a status|status update)\b/i,
  /\bplease (review|check|send|share|help|confirm|update|reply|take a look)\b/i,
  /\blet me know\b/i,
  /\bcan someone\b/i,
  /\bcan anyone\b/i,
  /\bwho can\b/i,
  /\bwhat can\b/i,
  /\banyone available\b/i,
];

const QUESTION_WORD_PATTERNS = [
  /\bwhat\b/i,
  /\bwhen\b/i,
  /\bwhere\b/i,
  /\bwhy\b/i,
  /\bhow\b/i,
  /\bwho\b/i,
];

const FOLLOW_UP_PATTERNS = [
  /\bfollow[ -]?up\b/i,
  /\bany update\b/i,
  /\bwhere are we\b/i,
  /\bwhere are you\b/i,
  /\bwhat'?s the status\b/i,
  /\bchecking in\b/i,
  /\bjust checking\b/i,
  /\bping\b/i,
  /\breminder\b/i,
  /\bwaiting on\b/i,
  /\bstill waiting\b/i,
];

const URGENCY_PATTERNS = [
  /\burgent\b/i,
  /\basap\b/i,
  /\btoday\b/i,
  /\bright away\b/i,
  /\bimmediately\b/i,
  /\bpriority\b/i,
  /\bblocked\b/i,
  /\bstuck\b/i,
  /\bneed this by\b/i,
];

const DIRECT_ADDRESS_PATTERNS = [
  /\bguys\b/i,
  /\bteam\b/i,
  /\banyone\b/i,
  /\beveryone\b/i,
  /\bhello\b/i,
  /\bhey\b/i,
  /\bhere\?*$/i,
  /<@[A-Z0-9]+>/,
];

const CLOSING_PATTERNS =
  /^(ok(ay)?|got\s*it|thanks?|thank\s*you|cool|sure|sounds?\s*good|perfect|great|noted|will\s*do|done|👍|✅|🙏|alright|ack|yep|yup|np|no\s*worries?)\b/i;

const OWNERSHIP_ACK_PATTERNS = [
  /\bon it\b/i,
  /\blooking into it\b/i,
  /\bchecking\b/i,
  /\bwill update\b/i,
  /\bi('|’)ll take a look\b/i,
  /\bi('|’)m on it\b/i,
  /\bworking on it\b/i,
];

const DEFERRAL_PATTERNS = [
  /\bwill do\b/i,
  /\bwill send\b/i,
  /\bwill share\b/i,
  /\bby (eod|today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
  /\bin \d+\s*(min|mins|minute|minutes|hour|hours)\b/i,
  /\bafter standup\b/i,
  /\blater today\b/i,
];

const SUBSTANTIVE_REPLY_PATTERNS = [
  /\bhere( is|'s)\b/i,
  /\bI (fixed|updated|sent|shared|pushed|added|checked|reviewed|merged)\b/i,
  /\bthe answer is\b/i,
  /\broot cause\b/i,
  /\bnext step\b/i,
  /\bETA\b/i,
  /\bplease see\b/i,
];

const NON_ACTIONABLE_PATTERNS = [
  /\bfyi\b/i,
  /\bfor your information\b/i,
  /\bjust sharing\b/i,
  /\bheads up\b/i,
  /\bnot a blocker\b/i,
  /\bno action needed\b/i,
  /\bfor visibility\b/i,
  /\bfor context\b/i,
];

const RESOLVED_UPDATE_PATTERNS = [
  /\beverything (is|'s)? working\b/i,
  /\bit('?s| is)? working (fine|now)\b/i,
  /\ball (working|good|set)\b/i,
  /\bissue (is )?(fixed|resolved)\b/i,
  /\bresolved now\b/i,
  /\bfixed now\b/i,
  /\bcompleted successfully\b/i,
  /\bno need to worry\b/i,
  /\bproblem solved\b/i,
  /\bworking as expected\b/i,
];

type FollowUpHeuristic = {
  shouldTrack: boolean;
  seriousness: FollowUpSeriousness;
  seriousnessScore: number;
  reasonCodes: string[];
  summary: string;
  isFollowUpNudge: boolean;
};

type FollowUpMessageOutcome =
  | "ignore"
  | "new_request"
  | "follow_up_nudge"
  | "ack_only"
  | "ownership_ack"
  | "deferral"
  | "substantive_reply"
  | "explicit_close";

type RoleMap = Map<string, UserRole | "unknown">;

type OwnershipLanes = {
  primaryResponderIds: string[];
  escalationResponderIds: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function slackTsToDate(ts: string | null | undefined): Date | null {
  if (!ts) {
    return null;
  }
  const parsed = Number.parseFloat(ts);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed * 1000);
}

export function scoreFollowUpText(
  text: string,
  repeatedAskCount = 1,
): FollowUpHeuristic {
  const normalized = text.trim();
  const questionMarks = (normalized.match(/\?/g) ?? []).length;
  const hasRequestLanguage = REQUEST_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasQuestionWord = QUESTION_WORD_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasFollowUpLanguage = FOLLOW_UP_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasUrgencyLanguage = URGENCY_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasDirectAddress = DIRECT_ADDRESS_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasNonActionableSignal = NON_ACTIONABLE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasResolvedUpdateSignal = RESOLVED_UPDATE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const hasExplicitQuestion =
    questionMarks > 0 && (hasQuestionWord || hasDirectAddress || hasRequestLanguage);
  const looksLikeShortPing =
    normalized.length <= 40 &&
    (hasFollowUpLanguage || (questionMarks > 0 && hasDirectAddress));

  if (
    normalized.length < 5 &&
    !hasFollowUpLanguage &&
    !hasUrgencyLanguage &&
    !looksLikeShortPing
  ) {
    return {
      shouldTrack: false,
      seriousness: "low",
      seriousnessScore: 0,
      reasonCodes: [],
      summary: "",
      isFollowUpNudge: false,
    };
  }

  if (
    normalized.length < 8 &&
    !(
      hasRequestLanguage ||
      hasFollowUpLanguage ||
      hasUrgencyLanguage ||
      looksLikeShortPing
    )
  ) {
    return {
      shouldTrack: false,
      seriousness: "low",
      seriousnessScore: 0,
      reasonCodes: [],
      summary: "",
      isFollowUpNudge: false,
    };
  }

  if (
    hasResolvedUpdateSignal &&
    !hasFollowUpLanguage &&
    !hasUrgencyLanguage &&
    !hasExplicitQuestion
  ) {
    return {
      shouldTrack: false,
      seriousness: "low",
      seriousnessScore: 0,
      reasonCodes: [],
      summary: "",
      isFollowUpNudge: false,
    };
  }

  if (hasNonActionableSignal && !hasFollowUpLanguage && !hasUrgencyLanguage) {
    return {
      shouldTrack: false,
      seriousness: "low",
      seriousnessScore: 0,
      reasonCodes: [],
      summary: "",
      isFollowUpNudge: false,
    };
  }

  const reasonCodes: string[] = [];
  let score = 0;

  if (hasRequestLanguage) {
    reasonCodes.push("request_language");
    score += 2;
  }

  if (hasFollowUpLanguage) {
    reasonCodes.push("follow_up_language");
    score += 3;
  }

  if (hasUrgencyLanguage) {
    reasonCodes.push("urgency_language");
    score += 3;
  }

  if (hasDirectAddress) {
    reasonCodes.push("direct_address");
    score += 1;
  }

  if (hasExplicitQuestion) {
    reasonCodes.push("explicit_question");
    score += 2;
  } else if (questionMarks >= 2 && hasDirectAddress) {
    reasonCodes.push("repeated_question_marks");
    score += 1;
  }

  if (repeatedAskCount > 1) {
    reasonCodes.push("repeated_ask");
    score += Math.min(5, repeatedAskCount + 1);
  }

  const shouldTrack =
    score >= 3 &&
    (hasRequestLanguage || hasFollowUpLanguage || hasUrgencyLanguage || hasExplicitQuestion);
  if (!shouldTrack) {
    return {
      shouldTrack: false,
      seriousness: "low",
      seriousnessScore: score,
      reasonCodes,
      summary: "",
      isFollowUpNudge: false,
    };
  }

  let seriousness: FollowUpSeriousness = "medium";
  if (score >= 7) seriousness = "high";
  else if (score <= 3) seriousness = "low";

  const summaryParts = [];
  if (reasonCodes.includes("follow_up_language")) {
    summaryParts.push("Requester asked for a follow-up");
  } else {
    summaryParts.push("Requester asked for a response");
  }
  if (reasonCodes.includes("urgency_language")) {
    summaryParts.push("urgency is explicit");
  }
  if (reasonCodes.includes("repeated_ask")) {
    summaryParts.push(`there have been ${repeatedAskCount} repeated nudges`);
  }

  return {
    shouldTrack,
    seriousness,
    seriousnessScore: score,
    reasonCodes: unique(reasonCodes),
    summary: `${summaryParts.join(", ")}.`,
    isFollowUpNudge:
      hasFollowUpLanguage || (repeatedAskCount > 1 && looksLikeShortPing),
  };
}

function toEffectiveRoleMap(
  entries: Awaited<ReturnType<typeof buildRoleDirectory>>,
): RoleMap {
  const map = new Map<string, UserRole | "unknown">();
  for (const entry of entries) {
    map.set(entry.userId, entry.effectiveRole);
  }
  return map;
}

function resolveEffectiveRole(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  userId: string,
): UserRole | "unknown" {
  const owners = new Set(rule?.owner_user_ids ?? []);
  const clients = new Set(rule?.client_user_ids ?? []);
  const seniors = new Set(rule?.senior_user_ids ?? []);

  if (clients.has(userId)) {
    return "client";
  }
  if (owners.has(userId)) {
    return "worker";
  }
  if (seniors.has(userId)) {
    return "senior";
  }

  return effectiveRoles.get(userId) ?? "unknown";
}

function resolveRequesterSide(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  userId: string,
): "owner" | "worker" | "client" | "senior" | "observer" | "unknown" {
  const owners = new Set(rule?.owner_user_ids ?? []);
  const clients = new Set(rule?.client_user_ids ?? []);
  const seniors = new Set(rule?.senior_user_ids ?? []);

  if (owners.has(userId)) {
    return "owner";
  }
  if (clients.has(userId)) {
    return "client";
  }
  if (seniors.has(userId)) {
    return "senior";
  }
  if (clients.size === 0 && owners.size > 0) {
    return owners.has(userId) ? "owner" : "client";
  }

  return effectiveRoles.get(userId) ?? "unknown";
}

export function resolveOwnershipLanes(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  requesterUserId: string,
): OwnershipLanes {
  const explicitPrimary = [...new Set(rule?.owner_user_ids ?? [])].filter(
    (userId) => userId !== requesterUserId,
  );
  const explicitEscalation = [...new Set(rule?.senior_user_ids ?? [])].filter(
    (userId) => userId !== requesterUserId,
  );

  if (explicitPrimary.length > 0 || explicitEscalation.length > 0) {
    return {
      primaryResponderIds: explicitPrimary,
      escalationResponderIds: explicitEscalation.filter(
        (userId) => !explicitPrimary.includes(userId),
      ),
    };
  }

  const requesterRole = resolveEffectiveRole(
    rule,
    effectiveRoles,
    requesterUserId,
  );

  const primaryResponderIds = [...effectiveRoles.entries()]
    .filter(([userId, role]) => {
      if (userId === requesterUserId) {
        return false;
      }
      if (requesterRole === "client") {
        return role === "worker";
      }
      if (requesterRole === "senior") {
        return role === "worker";
      }
      if (requesterRole === "worker") {
        return role === "client";
      }
      return role === "worker";
    })
    .map(([userId]) => userId);

  const escalationResponderIds = [...effectiveRoles.entries()]
    .filter(([userId, role]) => {
      if (userId === requesterUserId || primaryResponderIds.includes(userId)) {
        return false;
      }
      if (requesterRole === "worker") {
        return role === "senior";
      }
      if (requesterRole === "senior") {
        return role === "senior";
      }
      return role === "senior";
    })
    .map(([userId]) => userId);

  return { primaryResponderIds, escalationResponderIds };
}

function resolveExpectedResponderIds(
  lanes: OwnershipLanes,
): string[] {
  return [...new Set([...lanes.primaryResponderIds, ...lanes.escalationResponderIds])];
}

function isClosingAcknowledgment(text: string): boolean {
  return CLOSING_PATTERNS.test(text.trim());
}

function classifyMessageOutcome(text: string): FollowUpMessageOutcome {
  const normalized = text.trim();
  if (!normalized) {
    return "ignore";
  }

  if (isClosingAcknowledgment(normalized)) {
    return "explicit_close";
  }

  if (RESOLVED_UPDATE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "substantive_reply";
  }

  if (SUBSTANTIVE_REPLY_PATTERNS.some((pattern) => pattern.test(normalized)) || normalized.length >= 80) {
    return "substantive_reply";
  }

  if (DEFERRAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "deferral";
  }

  if (OWNERSHIP_ACK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "ownership_ack";
  }

  if (CLOSING_PATTERNS.test(normalized) || normalized.length <= 24) {
    return "ack_only";
  }

  const heuristic = scoreFollowUpText(normalized, 1);
  if (heuristic.shouldTrack) {
    return heuristic.isFollowUpNudge ? "follow_up_nudge" : "new_request";
  }

  return "ignore";
}

function hasPriorResponderEngagement(item: FollowUpItemRow): boolean {
  return Boolean(
    item.acknowledged_at ||
      item.engaged_at ||
      item.last_engagement_at ||
      item.last_responder_user_id,
  );
}

function dedupeFollowUps(items: FollowUpItemRow[]): FollowUpItemRow[] {
  const seen = new Set<string>();
  const deduped: FollowUpItemRow[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function selectSameChannelFallbackResolutions(params: {
  candidates: FollowUpItemRow[];
  rule: FollowUpRuleRow | null;
  effectiveRoles: RoleMap;
  actingUserId: string;
  rawText: string;
  replyTs: string;
}): FollowUpItemRow[] {
  const matched = params.candidates.filter((item) => {
    return canResolveAcrossThread(
      params.rule,
      params.effectiveRoles,
      item,
      params.actingUserId,
      params.rawText,
      params.replyTs,
    );
  });

  if (matched.length <= 1) {
    return matched;
  }

  const primaryRequester = matched[0]?.requester_user_id;
  if (!primaryRequester) {
    return matched.slice(0, 1);
  }

  return matched.filter((item) => item.requester_user_id === primaryRequester);
}

function isValidFollowUpReply(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  item: FollowUpItemRow,
  replierUserId: string,
): boolean {
  if (replierUserId === item.requester_user_id) {
    return false;
  }

  const owners = new Set(rule?.owner_user_ids ?? []);
  const clients = new Set(rule?.client_user_ids ?? []);
  const seniors = new Set(rule?.senior_user_ids ?? []);
  if (owners.size > 0) {
    if (owners.has(item.requester_user_id)) {
      return !clients.has(replierUserId);
    }
    return owners.has(replierUserId) || seniors.has(replierUserId);
  }

  const requesterRole = resolveEffectiveRole(
    rule,
    effectiveRoles,
    item.requester_user_id,
  );
  const replierRole = resolveEffectiveRole(rule, effectiveRoles, replierUserId);

  if (clients.size > 0 && clients.has(replierUserId)) {
    return false;
  }

  if (requesterRole === "client") {
    return replierRole === "worker" || replierRole === "senior";
  }

  if (requesterRole === "senior") {
    return replierRole === "worker" || replierRole === "senior";
  }

  if (requesterRole === "worker") {
    return replierRole === "senior" || replierRole === "client";
  }

  if (requesterRole === "observer") {
    return replierRole === "worker" || replierRole === "senior";
  }

  return replierRole !== "observer";
}

function canResolveAcrossThread(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  item: FollowUpItemRow,
  actingUserId: string,
  rawText: string,
  replyTs: string,
): boolean {
  if (!item.source_thread_ts || item.source_thread_ts === item.source_message_ts) {
    return false;
  }
  if (!isValidFollowUpReply(rule, effectiveRoles, item, actingUserId)) {
    return false;
  }

  const sourceTs = Number.parseFloat(item.source_message_ts);
  const currentTs = Number.parseFloat(replyTs);
  const maxWindowSeconds = config.FOLLOW_UP_CROSS_THREAD_REPLY_WINDOW_MINUTES * 60;
  const withinWindow =
    Number.isFinite(sourceTs) &&
    Number.isFinite(currentTs) &&
    currentTs - sourceTs <= maxWindowSeconds;
  if (!withinWindow) {
    return false;
  }

  return rawText.includes(`<@${item.requester_user_id}>`);
}

export function computeContextSLA(params: {
  senderRole: UserRole | "unknown";
  conversationType: ConversationType;
  messageIntent: string | null;
  urgencyLevel: string;
  configuredSlaHours: number;
}): number {
  let baseSla: number;
  switch (params.messageIntent) {
    case "blocker":
      baseSla = 4;
      break;
    case "escalation":
      baseSla = 4;
      break;
    case "request":
      baseSla = 12;
      break;
    case "question":
      baseSla = 12;
      break;
    case "decision":
      baseSla = 24;
      break;
    case "commitment":
      baseSla = 48;
      break;
    default:
      baseSla = params.configuredSlaHours;
      break;
  }

  if (params.senderRole === "client") baseSla = baseSla * 0.5;
  if (params.senderRole === "senior") baseSla = baseSla * 0.75;

  if (params.conversationType === "dm") baseSla = baseSla * 0.5;
  if (params.conversationType === "group_dm") baseSla = baseSla * 0.75;

  if (params.urgencyLevel === "critical") baseSla = Math.min(baseSla, 2);
  if (params.urgencyLevel === "high") baseSla = Math.min(baseSla, 4);

  // Floor at the configured SLA (allows sub-hour values for testing)
  // but never below 1 minute (0.0167 hours)
  const floor = Math.min(0.0167, params.configuredSlaHours);
  return Math.max(floor, Math.min(baseSla, params.configuredSlaHours));
}

function dueAtFromMessage(ts: string, slaHours: number): Date {
  const baseMs = Number.parseFloat(ts) * 1000;
  const fallbackMs = Date.now();
  const startMs = Number.isFinite(baseMs) ? baseMs : fallbackMs;
  return new Date(startMs + slaHours * 60 * 60 * 1000);
}

function visibilityAfterFromMessage(ts: string): Date {
  const baseMs = Number.parseFloat(ts) * 1000;
  const fallbackMs = Date.now();
  const startMs = Number.isFinite(baseMs) ? baseMs : fallbackMs;
  return new Date(startMs + config.FOLLOW_UP_REPLY_GRACE_MINUTES * 60 * 1000);
}

function inferMessageIntent(heuristic: FollowUpHeuristic): string | null {
  if (heuristic.reasonCodes.includes("follow_up_language")) {
    return "escalation";
  }
  if (heuristic.reasonCodes.includes("explicit_question")) {
    return "question";
  }
  if (heuristic.reasonCodes.includes("request_language")) {
    return "request";
  }
  return null;
}

function hasFollowUpActionSignal(heuristic: FollowUpHeuristic): boolean {
  return (
    heuristic.reasonCodes.includes("request_language") ||
    heuristic.reasonCodes.includes("follow_up_language") ||
    heuristic.reasonCodes.includes("urgency_language") ||
    heuristic.reasonCodes.includes("explicit_question")
  );
}

function hasFollowUpResponderSignal(
  rawText: string,
  heuristic: FollowUpHeuristic,
  expectedResponderIds: string[],
): boolean {
  return (
    expectedResponderIds.length > 0 ||
    rawText.includes("<@") ||
    heuristic.reasonCodes.includes("direct_address") ||
    hasFollowUpActionSignal(heuristic)
  );
}

function inferUrgencyLevel(heuristic: FollowUpHeuristic): string {
  return heuristic.reasonCodes.includes("urgency_language") ? "high" : "low";
}

function resolveResponseScope(
  rule: FollowUpRuleRow | null,
  effectiveRoles: RoleMap,
  item: FollowUpItemRow,
  actingUserId: string,
  threadTs: string | null,
  rawText: string,
  replyTs: string,
): "thread" | "channel" | null {
  if (!item.source_thread_ts) {
    if (threadTs && threadTs === item.source_message_ts) {
      return "thread";
    }
    return threadTs === null ? "channel" : null;
  }

  if (threadTs === item.source_thread_ts) {
    return "thread";
  }

  if (
    threadTs === null &&
    canResolveAcrossThread(
      rule,
      effectiveRoles,
      item,
      actingUserId,
      rawText,
      replyTs,
    )
  ) {
    return "channel";
  }

  return null;
}

export async function processFollowUpsForMessage(input: {
  workspaceId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string;
  text: string;
  rawText?: string;
}): Promise<void> {
  const { workspaceId, channelId, ts, threadTs, userId } = input;
  const text = input.text.trim();
  const rawText = (input.rawText ?? input.text).trim();

  const [rule, contextItems, channelItems, channel, roleDirectory] = await Promise.all([
    db.getFollowUpRule(workspaceId, channelId),
    db.listOpenFollowUpsForResolutionContext(
      workspaceId,
      channelId,
      threadTs,
      ts,
    ),
    db.listOpenFollowUpsForChannelResolution(workspaceId, channelId, ts),
    db.getChannel(workspaceId, channelId),
    buildRoleDirectory(workspaceId),
  ]);
  const effectiveRoles = toEffectiveRoleMap(roleDirectory);
  const outcome = classifyMessageOutcome(text);

  const sameChannelFallback =
    threadTs === null
      ? selectSameChannelFallbackResolutions({
          candidates: channelItems.filter(
            (item) =>
              item.source_thread_ts !== null &&
              !contextItems.some((contextItem) => contextItem.id === item.id),
          ),
          rule,
          effectiveRoles,
          actingUserId: userId,
          rawText,
          replyTs: ts,
        })
      : [];

  const candidates = dedupeFollowUps([...contextItems, ...sameChannelFallback]);
  const acknowledgedIds = new Set<string>();
  const resolvedIds = new Set<string>();

  for (const item of candidates) {
    const responseScope = resolveResponseScope(
      rule,
      effectiveRoles,
      item,
      userId,
      threadTs,
      rawText,
      ts,
    );
    if (!responseScope) {
      continue;
    }

    if (userId !== item.requester_user_id) {
      if (!isValidFollowUpReply(rule, effectiveRoles, item, userId)) {
        continue;
      }

      if (outcome === "substantive_reply" || outcome === "explicit_close") {
        await clearFollowUpReminderDms(workspaceId, item.id);
        await db.resolveFollowUpItem({
          itemId: item.id,
          resolvedMessageTs: ts,
          resolutionReason: "reply",
          resolutionScope: responseScope,
          resolvedByUserId: userId,
          lastEngagementAt: slackTsToDate(ts),
          resolvedViaEscalation: item.workflow_state === "escalated",
          primaryMissedSla:
            item.primary_missed_sla || item.workflow_state === "escalated",
        });
        await db.recordFollowUpEvent({
          followUpItemId: item.id,
          workspaceId,
          channelId,
          eventType: "resolved",
          workflowState: "resolved",
          actorUserId: userId,
          messageTs: ts,
          metadata: {
            resolutionReason: "reply",
            responseScope,
          },
        });
        // Back-propagate to meeting obligation if this follow-up was bridged from a meeting
        if (config.FATHOM_ENABLED) {
          const meetingObligationId = await db.getFollowUpItemMeetingObligationId(item.id);
          if (meetingObligationId) {
            await backPropagateFollowUpResolution(item.id, meetingObligationId);
          }
        }
        emitFollowUpAlert({
          workspaceId,
          channelId,
          followUpItemId: item.id,
          alertType: "follow_up_resolved",
          changeType: "resolved",
          seriousness: item.seriousness,
          sourceMessageTs: item.source_message_ts,
          threadTs: item.source_thread_ts,
          summary: item.summary,
        });
        resolvedIds.add(item.id);
        continue;
      }

      if (
        outcome === "ack_only" ||
        outcome === "ownership_ack" ||
        outcome === "deferral"
      ) {
        const ackExtensionHours = Math.min(
          config.FOLLOW_UP_ACK_EXTENSION_HOURS,
          rule?.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
        );
        const nextDueAt = dueAtFromMessage(ts, ackExtensionHours);
        await db.acknowledgeFollowUpItem({
          itemId: item.id,
          dueAt: nextDueAt,
          acknowledgedAt: slackTsToDate(ts) ?? new Date(),
          acknowledgedByUserId: userId,
          acknowledgmentSource: "message",
          responderMessageTs: ts,
        });
        await db.recordFollowUpEvent({
          followUpItemId: item.id,
          workspaceId,
          channelId,
          eventType: "acknowledged",
          workflowState: "acknowledged_waiting",
          actorUserId: userId,
          messageTs: ts,
          metadata: {
            outcome,
            nextDueAt: nextDueAt.toISOString(),
          },
        });
        emitFollowUpAlert({
          workspaceId,
          channelId,
          followUpItemId: item.id,
          alertType: "follow_up_opened",
          changeType: "acknowledged",
          seriousness: item.seriousness,
          sourceMessageTs: item.source_message_ts,
          threadTs: item.source_thread_ts,
          summary: "Acknowledged, waiting on completion.",
        });
        acknowledgedIds.add(item.id);
      }

      continue;
    }

    if (
      (outcome === "explicit_close" || outcome === "ack_only") &&
      hasPriorResponderEngagement(item)
    ) {
      await clearFollowUpReminderDms(workspaceId, item.id);
      await db.resolveFollowUpItem({
        itemId: item.id,
        resolvedMessageTs: ts,
        resolutionReason: "requester_ack",
        resolutionScope: responseScope,
        resolvedByUserId: userId,
        lastEngagementAt: slackTsToDate(ts),
        resolvedViaEscalation: item.workflow_state === "escalated",
        primaryMissedSla:
          item.primary_missed_sla || item.workflow_state === "escalated",
      });
      await db.recordFollowUpEvent({
        followUpItemId: item.id,
        workspaceId,
        channelId,
        eventType: "resolved",
        workflowState: "resolved",
        actorUserId: userId,
        messageTs: ts,
        metadata: {
          resolutionReason: "requester_ack",
          responseScope,
        },
      });
      emitFollowUpAlert({
        workspaceId,
        channelId,
        followUpItemId: item.id,
        alertType: "follow_up_resolved",
        changeType: "resolved",
        seriousness: item.seriousness,
        sourceMessageTs: item.source_message_ts,
        threadTs: item.source_thread_ts,
        summary: "Requester acknowledged the response and closed the loop.",
      });
      resolvedIds.add(item.id);
    }
  }

  const ignoredCandidates = channelItems.filter((item) => {
    if (resolvedIds.has(item.id) || acknowledgedIds.has(item.id)) {
      return false;
    }
    if (item.requester_user_id === userId) {
      return false;
    }
    if (!item.primary_responder_ids.includes(userId)) {
      return false;
    }
    return resolveResponseScope(
      rule,
      effectiveRoles,
      item,
      userId,
      threadTs,
      rawText,
      ts,
    ) === null;
  });

  for (const item of ignoredCandidates) {
    await db.incrementFollowUpIgnoredScore(item.id);
  }

  const conversationType =
    rule?.conversation_type ?? channel?.conversation_type ?? "public_channel";
  const privacyAllowed =
    conversationType === "public_channel" || Boolean(rule?.privacy_opt_in);
  const trackingEnabled = rule?.enabled ?? true;

  if (!privacyAllowed || rule?.muted || !trackingEnabled) {
    return;
  }

  const requesterSide = resolveRequesterSide(rule, effectiveRoles, userId);

  const existingOpen = await db.getOpenFollowUpForRequesterContext(
    workspaceId,
    channelId,
    userId,
    threadTs,
  );
  const repeatedAskCount = (existingOpen?.repeated_ask_count ?? 0) + 1;
  const heuristic = scoreFollowUpText(text, repeatedAskCount);
  const ownershipLanes = resolveOwnershipLanes(
    rule,
    effectiveRoles,
    userId,
  );
  const expectedResponderIds = resolveExpectedResponderIds(ownershipLanes);
  const hasResponderSignal = hasFollowUpResponderSignal(
    rawText,
    heuristic,
    expectedResponderIds,
  );
  const hasActionSignal = hasFollowUpActionSignal(heuristic);

  if (!heuristic.shouldTrack || !hasResponderSignal || !hasActionSignal) {
    return;
  }

  // Resolve requester name so summaries and notifications show a real name
  const requesterProfile = await db.getUserProfile(workspaceId, userId);
  const requesterName =
    requesterProfile?.display_name ?? requesterProfile?.real_name ?? userId;
  if (heuristic.summary) {
    heuristic.summary = heuristic.summary.replace(
      /\bRequester\b/,
      requesterName,
    );
  }

  const detectionMode =
    requesterSide === "client" && rule?.enabled
      ? "rule"
      : requesterSide === "senior"
        ? "hybrid"
        : requesterSide === "unknown" && rule?.enabled
          ? "hybrid"
          : "heuristic";

  const senderRole = resolveEffectiveRole(rule, effectiveRoles, userId);
  const contextSlaHours = computeContextSLA({
    senderRole,
    conversationType,
    messageIntent: inferMessageIntent(heuristic),
    urgencyLevel: inferUrgencyLevel(heuristic),
    configuredSlaHours: rule?.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
  });
  const dueAt = dueAtFromMessage(ts, contextSlaHours);

  if (existingOpen && heuristic.isFollowUpNudge) {
    const seriousnessChanged =
      heuristic.seriousness !== existingOpen.seriousness;
    await db.clearFollowUpSnooze(existingOpen.id);
    const reopenedState: FollowUpWorkflowState =
      existingOpen.workflow_state === "acknowledged_waiting" &&
      ownershipLanes.escalationResponderIds.length > 0
        ? "escalated"
        : existingOpen.workflow_state === "pending_reply_window"
          ? "awaiting_primary"
          : existingOpen.workflow_state;
    await db.bumpFollowUpItem({
      itemId: existingOpen.id,
      lastRequestTs: ts,
      seriousness: heuristic.seriousness,
      seriousnessScore: heuristic.seriousnessScore,
      reasonCodes: heuristic.reasonCodes,
      summary: heuristic.summary,
      dueAt,
      workflowState: reopenedState,
      visibilityAfter:
        reopenedState === "awaiting_primary" || reopenedState === "escalated"
          ? new Date()
          : null,
      nextExpectedResponseAt: dueAt,
    });
    await db.recordFollowUpEvent({
      followUpItemId: existingOpen.id,
      workspaceId,
      channelId,
      eventType:
        reopenedState === "escalated" ? "escalated" : "reopened",
      workflowState: reopenedState,
      actorUserId: userId,
      messageTs: ts,
      metadata: {
        seriousnessChanged,
      },
    });

    emitFollowUpAlert({
      workspaceId,
      channelId,
      followUpItemId: existingOpen.id,
      alertType:
        heuristic.seriousness === "high"
          ? "follow_up_high_priority"
          : "follow_up_opened",
      changeType:
        reopenedState === "escalated"
          ? "escalated"
          : seriousnessChanged
            ? "severity_changed"
            : "reopened",
      seriousness: heuristic.seriousness,
      sourceMessageTs: existingOpen.source_message_ts,
      threadTs: existingOpen.source_thread_ts,
      summary: heuristic.summary,
    });
    return;
  }

  const created = await db.createFollowUpItem({
    workspaceId,
    channelId,
    sourceMessageTs: ts,
    sourceThreadTs: threadTs,
    requesterUserId: userId,
    seriousness: heuristic.seriousness,
    seriousnessScore: heuristic.seriousnessScore,
    detectionMode,
    reasonCodes: heuristic.reasonCodes,
    summary: heuristic.summary,
    dueAt,
    workflowState: "pending_reply_window",
    primaryResponderIds: ownershipLanes.primaryResponderIds,
    escalationResponderIds: ownershipLanes.escalationResponderIds,
    visibilityAfter: visibilityAfterFromMessage(ts),
    nextExpectedResponseAt: dueAt,
    metadata: {
      requesterSide,
      ruleEnabled: trackingEnabled,
      expectedResponderIds,
      primaryResponderIds: ownershipLanes.primaryResponderIds,
      escalationResponderIds: ownershipLanes.escalationResponderIds,
      seniorOwnedFromStart:
        ownershipLanes.primaryResponderIds.length === 0 &&
        ownershipLanes.escalationResponderIds.length > 0,
    },
  });
  await db.recordFollowUpEvent({
    followUpItemId: created.id,
    workspaceId,
    channelId,
    eventType: "created",
    workflowState: "pending_reply_window",
    actorUserId: userId,
    messageTs: ts,
    metadata: {
      primaryResponderIds: ownershipLanes.primaryResponderIds,
      escalationResponderIds: ownershipLanes.escalationResponderIds,
    },
  });

  log.debug(
    {
      channelId,
      sourceMessageTs: created.source_message_ts,
      seriousness: created.seriousness,
      requesterUserId: created.requester_user_id,
    },
    "Created follow-up reminder candidate",
  );

  // Follow-up notifications are sent as personal DMs only (via followUpSweep),
  // not posted in channels/threads, to avoid noise.
}

export async function reconcileFollowUpSourceEdit(input: {
  workspaceId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string;
  text: string;
  rawText?: string;
}): Promise<void> {
  const { workspaceId, channelId, ts, threadTs, userId } = input;
  const text = input.text.trim();
  const rawText = (input.rawText ?? input.text).trim();

  const [existingItem, rule, channel, roleDirectory] = await Promise.all([
    db.getFollowUpBySourceTs(workspaceId, channelId, ts),
    db.getFollowUpRule(workspaceId, channelId),
    db.getChannel(workspaceId, channelId),
    buildRoleDirectory(workspaceId),
  ]);

  const effectiveRoles = toEffectiveRoleMap(roleDirectory);
  const ownershipLanes = resolveOwnershipLanes(rule, effectiveRoles, userId);
  const expectedResponderIds = resolveExpectedResponderIds(ownershipLanes);
  const repeatedAskCount = Math.max(1, existingItem?.repeated_ask_count ?? 1);
  const heuristic = scoreFollowUpText(text, repeatedAskCount);
  const hasResponderSignal = hasFollowUpResponderSignal(
    rawText,
    heuristic,
    expectedResponderIds,
  );
  const hasActionSignal = hasFollowUpActionSignal(heuristic);
  const shouldTrack = heuristic.shouldTrack && hasResponderSignal && hasActionSignal;
  const outcome = classifyMessageOutcome(text);

  if (
    existingItem?.status === "open" &&
    (
      !shouldTrack ||
      outcome === "substantive_reply" ||
      outcome === "ack_only" ||
      outcome === "ownership_ack" ||
      outcome === "deferral" ||
      outcome === "explicit_close"
    )
  ) {
    await clearFollowUpReminderDms(workspaceId, existingItem.id);
    await db.dismissFollowUpItem(existingItem.id, userId);
    await db.recordFollowUpEvent({
      followUpItemId: existingItem.id,
      workspaceId,
      channelId,
      eventType: "dismissed",
      workflowState: "dismissed",
      actorUserId: userId,
      messageTs: ts,
      metadata: {
        reason: "source_message_edited_non_actionable",
      },
    });
    emitFollowUpAlert({
      workspaceId,
      channelId,
      followUpItemId: existingItem.id,
      alertType: "follow_up_dismissed",
      changeType: "dismissed",
      seriousness: existingItem.seriousness,
      sourceMessageTs: existingItem.source_message_ts,
      threadTs: existingItem.source_thread_ts,
      summary: "The source message was edited into a non-actionable update, so this follow-up was removed.",
    });
    return;
  }

  const conversationType =
    rule?.conversation_type ?? channel?.conversation_type ?? "public_channel";
  const privacyAllowed =
    conversationType === "public_channel" || Boolean(rule?.privacy_opt_in);
  const trackingEnabled = rule?.enabled ?? true;

  if (!privacyAllowed || rule?.muted || !trackingEnabled || !shouldTrack) {
    return;
  }

  const requesterProfile = await db.getUserProfile(workspaceId, userId);
  const requesterName =
    requesterProfile?.display_name ?? requesterProfile?.real_name ?? userId;
  if (heuristic.summary) {
    heuristic.summary = heuristic.summary.replace(/\bRequester\b/, requesterName);
  }

  const requesterSide = resolveRequesterSide(rule, effectiveRoles, userId);
  const detectionMode =
    requesterSide === "client" && rule?.enabled
      ? "rule"
      : requesterSide === "senior"
        ? "hybrid"
        : requesterSide === "unknown" && rule?.enabled
          ? "hybrid"
          : "heuristic";
  const senderRole = resolveEffectiveRole(rule, effectiveRoles, userId);
  const contextSlaHours = computeContextSLA({
    senderRole,
    conversationType,
    messageIntent: inferMessageIntent(heuristic),
    urgencyLevel: inferUrgencyLevel(heuristic),
    configuredSlaHours: rule?.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
  });
  const dueAt = dueAtFromMessage(ts, contextSlaHours);
  const metadata = {
    requesterSide,
    ruleEnabled: trackingEnabled,
    expectedResponderIds,
    primaryResponderIds: ownershipLanes.primaryResponderIds,
    escalationResponderIds: ownershipLanes.escalationResponderIds,
    seniorOwnedFromStart:
      ownershipLanes.primaryResponderIds.length === 0 &&
      ownershipLanes.escalationResponderIds.length > 0,
  };

  if (existingItem?.status === "resolved") {
    const workflowState: FollowUpWorkflowState =
      ownershipLanes.primaryResponderIds.length === 0 &&
      ownershipLanes.escalationResponderIds.length > 0
        ? "escalated"
        : "awaiting_primary";
    await db.reopenFollowUpItem({
      itemId: existingItem.id,
      lastRequestTs: ts,
      seriousness: heuristic.seriousness,
      seriousnessScore: heuristic.seriousnessScore,
      reasonCodes: heuristic.reasonCodes,
      summary: heuristic.summary,
      workflowState,
      dueAt,
      visibilityAfter: new Date(),
      nextExpectedResponseAt: dueAt,
    });
    await db.recordFollowUpEvent({
      followUpItemId: existingItem.id,
      workspaceId,
      channelId,
      eventType: workflowState === "escalated" ? "escalated" : "reopened",
      workflowState,
      actorUserId: userId,
      messageTs: ts,
      metadata: {
        reason: "source_message_edited_actionable",
      },
    });
    emitFollowUpAlert({
      workspaceId,
      channelId,
      followUpItemId: existingItem.id,
      alertType:
        heuristic.seriousness === "high"
          ? "follow_up_high_priority"
          : "follow_up_opened",
      changeType: workflowState === "escalated" ? "escalated" : "reopened",
      seriousness: heuristic.seriousness,
      sourceMessageTs: existingItem.source_message_ts,
      threadTs: existingItem.source_thread_ts,
      summary: heuristic.summary,
    });
    return;
  }

  const created = await db.createFollowUpItem({
    workspaceId,
    channelId,
    sourceMessageTs: ts,
    sourceThreadTs: threadTs,
    requesterUserId: userId,
    seriousness: heuristic.seriousness,
    seriousnessScore: heuristic.seriousnessScore,
    detectionMode,
    reasonCodes: heuristic.reasonCodes,
    summary: heuristic.summary,
    dueAt,
    workflowState: existingItem?.workflow_state ?? "pending_reply_window",
    primaryResponderIds: ownershipLanes.primaryResponderIds,
    escalationResponderIds: ownershipLanes.escalationResponderIds,
    visibilityAfter:
      existingItem?.workflow_state &&
      existingItem.workflow_state !== "pending_reply_window"
        ? new Date()
        : visibilityAfterFromMessage(ts),
    nextExpectedResponseAt: dueAt,
    metadata,
  });

  if (!existingItem) {
    await db.recordFollowUpEvent({
      followUpItemId: created.id,
      workspaceId,
      channelId,
      eventType: "created",
      workflowState: created.workflow_state,
      actorUserId: userId,
      messageTs: ts,
      metadata,
    });
  }
}
