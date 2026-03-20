import * as db from "../db/queries.js";
import type {
  RoleAssignmentRow,
  UserRole,
} from "../types/database.js";

export interface RoleSuggestion {
  role: UserRole;
  confidence: number;
  source: "policy" | "profile" | "interaction";
  reasons: string[];
}

export interface RoleDirectoryEntry {
  userId: string;
  displayName: string;
  profileImage: string | null;
  email: string | null;
  messageCount: number;
  channelCount: number;
  confirmedRole: UserRole | null;
  displayLabel: string | null;
  suggestedRole: RoleSuggestion | null;
  effectiveRole: UserRole | "unknown";
  assignments: RoleAssignmentRow[];
}

type PolicyMembership = {
  ownerIds: Set<string>;
  clientIds: Set<string>;
  seniorIds: Set<string>;
};

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(0.99, Math.round(value * 100) / 100));
}

function resolveSuggestedRole(
  signal: Awaited<ReturnType<typeof db.getRoleInferenceSignals>>[number],
  membership: PolicyMembership,
): RoleSuggestion | null {
  const reasons: string[] = [];

  if (membership.clientIds.has(signal.user_id)) {
    return {
      role: "client",
      confidence: 0.98,
      source: "policy",
      reasons: ["Marked as a client in channel policy."],
    };
  }

  if (membership.ownerIds.has(signal.user_id)) {
    return {
      role: "worker",
      confidence: 0.95,
      source: "policy",
      reasons: ["Marked as an owner in channel policy."],
    };
  }

  if (membership.seniorIds.has(signal.user_id)) {
    return {
      role: "senior",
      confidence: 0.97,
      source: "policy",
      reasons: ["Marked as senior leadership in channel policy."],
    };
  }

  if (signal.is_owner || signal.is_admin) {
    reasons.push(signal.is_owner ? "Slack workspace owner." : "Slack workspace admin.");
    return {
      role: "senior",
      confidence: signal.is_owner ? 0.94 : 0.88,
      source: "profile",
      reasons,
    };
  }

  if (
    signal.follow_up_request_count >= 2 &&
    signal.follow_up_request_count >= signal.follow_up_resolution_count + 1
  ) {
    reasons.push("Frequently initiates unanswered requests.");
    if (signal.reply_count <= Math.max(1, Math.floor(signal.message_count * 0.25))) {
      reasons.push("Rarely resolves threads after asking.");
    }
    return {
      role: "client",
      confidence: clampConfidence(0.64 + Math.min(0.18, signal.follow_up_request_count * 0.04)),
      source: "interaction",
      reasons,
    };
  }

  if (signal.follow_up_resolution_count >= 2) {
    reasons.push("Frequently resolves open follow-up requests.");
    if (signal.channel_count >= 2) {
      reasons.push("Responds across multiple channels.");
    }
    return {
      role: "worker",
      confidence: clampConfidence(0.61 + Math.min(0.2, signal.follow_up_resolution_count * 0.05)),
      source: "interaction",
      reasons,
    };
  }

  if (signal.decision_signal_count >= 2 && signal.message_count <= 20) {
    reasons.push("Contributes lower-volume but decision-oriented messages.");
    return {
      role: "senior",
      confidence: clampConfidence(0.58 + Math.min(0.16, signal.decision_signal_count * 0.04)),
      source: "interaction",
      reasons,
    };
  }

  if (signal.message_count > 0) {
    return {
      role: "observer",
      confidence: 0.4,
      source: "interaction",
      reasons: ["Observed in conversation, but no strong responsibility signal yet."],
    };
  }

  return null;
}

function getMembership(
  policies: Awaited<ReturnType<typeof db.listConversationPolicies>>,
): PolicyMembership {
  const ownerIds = new Set<string>();
  const clientIds = new Set<string>();
  const seniorIds = new Set<string>();

  for (const policy of policies) {
    for (const userId of policy.owner_user_ids ?? []) ownerIds.add(userId);
    for (const userId of policy.client_user_ids ?? []) clientIds.add(userId);
    for (const userId of policy.senior_user_ids ?? []) seniorIds.add(userId);
  }

  return { ownerIds, clientIds, seniorIds };
}

export async function buildRoleDirectory(
  workspaceId: string,
): Promise<RoleDirectoryEntry[]> {
  const [signals, assignments, policies] = await Promise.all([
    db.getRoleInferenceSignals(workspaceId),
    db.listRoleAssignments(workspaceId),
    db.listConversationPolicies(workspaceId),
  ]);

  const membership = getMembership(policies);
  const assignmentMap = new Map<string, RoleAssignmentRow[]>();

  for (const assignment of assignments) {
    const current = assignmentMap.get(assignment.user_id) ?? [];
    current.push(assignment);
    assignmentMap.set(assignment.user_id, current);
  }

  return signals.map((signal) => {
    const userAssignments = assignmentMap.get(signal.user_id) ?? [];
    const confirmed = userAssignments.find((entry) => entry.review_state === "confirmed");
    const rejectedRoles = new Set(
      userAssignments
        .filter((entry) => entry.review_state === "rejected")
        .map((entry) => entry.role),
    );

    let suggestion = resolveSuggestedRole(signal, membership);
    if (suggestion && rejectedRoles.has(suggestion.role)) {
      suggestion = null;
    }

    const displayName =
      signal.display_name ??
      signal.real_name ??
      signal.email ??
      signal.user_id;

    return {
      userId: signal.user_id,
      displayName,
      profileImage: signal.profile_image,
      email: signal.email,
      messageCount: signal.message_count,
      channelCount: signal.channel_count,
      confirmedRole: confirmed?.role ?? null,
      displayLabel: confirmed?.display_label ?? null,
      suggestedRole: suggestion,
      effectiveRole: confirmed?.role ?? suggestion?.role ?? "unknown",
      assignments: userAssignments,
    };
  });
}

export async function reviewRoleAssignment(input: {
  workspaceId: string;
  userId: string;
  role: UserRole;
  action: "confirm" | "reject" | "clear";
  displayLabel?: string;
}): Promise<void> {
  if (input.action === "clear") {
    await db.clearRoleAssignmentsForUser(input.workspaceId, input.userId);
    return;
  }

  if (input.action === "confirm") {
    await db.clearRoleAssignmentsForUser(input.workspaceId, input.userId);
    await db.upsertRoleAssignment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      source: "manual",
      reviewState: "confirmed",
      confidence: 1,
      reasons: ["Confirmed manually in PulseBoard settings."],
      displayLabel: input.displayLabel ?? null,
    });
    return;
  }

  await db.upsertRoleAssignment({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    source: "inferred",
    reviewState: "rejected",
    confidence: 0,
    reasons: ["Rejected manually in PulseBoard settings."],
  });
}
