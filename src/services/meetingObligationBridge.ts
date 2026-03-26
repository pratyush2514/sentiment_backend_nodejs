import { config } from "../config.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import type { MeetingObligationRow } from "../types/database.js";

const log = logger.child({ service: "meetingObligationBridge" });

/**
 * Bridge actionable meeting obligations into existing follow_up_items.
 * Only action_items, commitments, and next_steps are bridged.
 * Decisions, questions, and risks are tracked but not as follow-ups.
 */
export async function bridgeObligationsToFollowUps(
  workspaceId: string,
  meetingId: string,
  channelId: string,
  digestMessageTs: string | null,
): Promise<number> {
  const obligations = await db.getMeetingObligations(workspaceId, meetingId);
  const actionable = obligations.filter((o) =>
    ["action_item", "commitment", "next_step"].includes(o.obligation_type) &&
    o.status === "open" &&
    !o.follow_up_item_id,
  );

  if (actionable.length === 0) {
    log.info({ workspaceId, meetingId }, "No actionable obligations to bridge");
    return 0;
  }

  let bridgedCount = 0;

  for (const obligation of actionable) {
    try {
      const dueAt = computeDueDate(obligation);
      const primaryResponderIds = obligation.owner_user_id ? [obligation.owner_user_id] : [];

      // Use extraction confidence to modulate seriousness score:
      // High confidence (>0.8) → full score. Low confidence (0.4-0.6) → damped score.
      const baseScore = mapPriorityToScore(obligation.priority);
      const confidenceMultiplier = 0.5 + 0.5 * (obligation.extraction_confidence ?? 0.8);
      const adjustedScore = Math.round(baseScore * confidenceMultiplier);

      const followUpItem = await db.createFollowUpItem({
        workspaceId,
        channelId,
        sourceMessageTs: digestMessageTs ?? `meeting:${meetingId}`,
        sourceThreadTs: null,
        requesterUserId: "",
        workflowState: "awaiting_primary",
        seriousness: mapPriorityToSeriousness(obligation.priority),
        seriousnessScore: adjustedScore,
        detectionMode: "meeting" as const,
        reasonCodes: [`meeting:${obligation.obligation_type}`],
        summary: obligation.title,
        dueAt,
        primaryResponderIds,
        escalationResponderIds: [],
      });

      if (followUpItem) {
        // Atomically link both sides in a single transaction
        await db.linkObligationAndFollowUp(obligation.id, followUpItem.id);
        bridgedCount++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { workspaceId, meetingId, obligationId: obligation.id, err: errMsg },
        "Failed to bridge obligation to follow-up",
      );
    }
  }

  log.info(
    { workspaceId, meetingId, channelId, bridgedCount, total: actionable.length },
    "Meeting obligations bridged to follow-ups",
  );

  return bridgedCount;
}

/**
 * Back-propagate follow-up resolution to the linked meeting obligation.
 * Called when a follow_up_item with meeting_obligation_id is resolved.
 */
export async function backPropagateFollowUpResolution(
  followUpItemId: string,
  meetingObligationId: string,
): Promise<void> {
  try {
    await db.resolveMeetingObligation(
      meetingObligationId,
      "completed",
      `Resolved via Slack follow-up ${followUpItemId}`,
    );
    log.info(
      { followUpItemId, meetingObligationId },
      "Meeting obligation resolved via follow-up back-propagation",
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn(
      { followUpItemId, meetingObligationId, err: errMsg },
      "Failed to back-propagate follow-up resolution to meeting obligation",
    );
  }
}

function computeDueDate(obligation: MeetingObligationRow): Date {
  if (obligation.due_date) {
    return new Date(obligation.due_date);
  }
  // Default to FATHOM_DEFAULT_OBLIGATION_SLA_HOURS from config
  const hoursFromNow = config.FATHOM_DEFAULT_OBLIGATION_SLA_HOURS;
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
}

function mapPriorityToSeriousness(priority: string): "low" | "medium" | "high" {
  switch (priority) {
    case "critical":
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

function mapPriorityToScore(priority: string): number {
  switch (priority) {
    case "critical":
      return 95;
    case "high":
      return 80;
    case "medium":
      return 50;
    default:
      return 30;
  }
}
