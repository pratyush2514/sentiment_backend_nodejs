import { config } from "../config.js";
import { pool } from "../db/pool.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { emitFollowUpAlert } from "./followUpEvents.js";
import { reconcileMissingFollowUps } from "./followUpReconcile.js";
import { clearFollowUpReminderDms } from "./followUpReminderDms.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { FollowUpItemWithContextRow, DmRef } from "../db/queries.js";
import type { FollowUpSeriousness, UserRole } from "../types/database.js";

const log = logger.child({ service: "followUpSweep" });

let timer: NodeJS.Timeout | null = null;
let sweepInProgress = false;
const FOLLOW_UP_SWEEP_LOCK_NAMESPACE = 73141;
const FOLLOW_UP_SWEEP_LOCK_ID = 1;

async function tryAcquireSweepLock(): Promise<boolean> {
  const result = await pool.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock($1, $2) AS acquired`,
    [FOLLOW_UP_SWEEP_LOCK_NAMESPACE, FOLLOW_UP_SWEEP_LOCK_ID],
  );
  return Boolean(result.rows[0]?.acquired);
}

async function releaseSweepLock(): Promise<void> {
  await pool.query(`SELECT pg_advisory_unlock($1, $2)`, [
    FOLLOW_UP_SWEEP_LOCK_NAMESPACE,
    FOLLOW_UP_SWEEP_LOCK_ID,
  ]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveSlackReminderTargets(
  primaryResponderIds: string[] | null | undefined,
  escalationResponderIds: string[] | null | undefined,
  workflowState: FollowUpItemWithContextRow["workflow_state"],
  ownerIds: string[] | null | undefined,
  seniorIds: string[] | null | undefined,
  confirmedRoles: Map<string, UserRole>,
  requesterUserId: string,
): string[] {
  const primary = [...new Set(primaryResponderIds ?? [])].filter(
    (userId) => userId !== requesterUserId,
  );
  const escalation = [...new Set(escalationResponderIds ?? [])].filter(
    (userId) => userId !== requesterUserId,
  );

  if (workflowState === "escalated" && escalation.length > 0) {
    return escalation;
  }
  if (primary.length > 0) {
    return primary;
  }
  if (escalation.length > 0) {
    return escalation;
  }

  const explicit = [...new Set([...(ownerIds ?? []), ...(seniorIds ?? [])])].filter(
    (userId) => userId !== requesterUserId,
  );
  if (workflowState === "escalated" && (seniorIds?.length ?? 0) > 0) {
    return [...new Set(seniorIds ?? [])].filter((userId) => userId !== requesterUserId);
  }
  if (explicit.length > 0) {
    return explicit;
  }

  return [...confirmedRoles.entries()]
    .filter(([userId, role]) => {
      if (userId === requesterUserId) return false;
      return role === "worker" || role === "senior" || role === "client";
    })
    .map(([userId]) => userId);
}

function getHoursOverdue(item: FollowUpItemWithContextRow): number {
  const dueAt =
    item.due_at instanceof Date
      ? item.due_at.getTime()
      : new Date(item.due_at).getTime();
  return Math.max(0, (Date.now() - dueAt) / (60 * 60 * 1000));
}

function scoreOverdueItem(item: FollowUpItemWithContextRow): {
  seriousness: FollowUpSeriousness;
  score: number;
  summary: string;
} {
  const hoursOverdue = getHoursOverdue(item);

  let score =
    item.seriousness_score +
    Math.floor(hoursOverdue / 6) +
    item.repeated_ask_count;
  if ((item.reason_codes ?? []).includes("urgency_language")) {
    score += 2;
  }

  let seriousness: FollowUpSeriousness = "medium";
  if (score >= 10) seriousness = "high";
  else if (score <= 4) seriousness = "low";

  const requesterName =
    item.requester_display_name ??
    item.requester_real_name ??
    item.requester_user_id;

  let overdueLabel = "";
  if (hoursOverdue >= 1) {
    const days = Math.floor(hoursOverdue / 24);
    const hours = Math.round(hoursOverdue % 24);
    overdueLabel = days >= 1 ? `${days}d ${hours}h overdue` : `${Math.round(hoursOverdue)}h overdue`;
  }
  const summary = `${requesterName} is still waiting for a reply${overdueLabel ? ` (${overdueLabel})` : ""}.`;

  return { seriousness, score, summary };
}

export function shouldQuietlyConclude(
  item: FollowUpItemWithContextRow,
  hoursOverdue: number,
  thresholds: {
    lowHours: number;
    mediumHours: number;
  } = {
    lowHours: config.FOLLOW_UP_SILENT_CLOSE_LOW_HOURS,
    mediumHours: config.FOLLOW_UP_SILENT_CLOSE_MEDIUM_HOURS,
  },
): boolean {
  const reasonCodes = new Set(item.reason_codes ?? []);
  const lowPressure =
    item.workflow_state === "awaiting_primary" &&
    item.repeated_ask_count <= 1 &&
    !reasonCodes.has("urgency_language") &&
    !reasonCodes.has("follow_up_language") &&
    item.detection_mode !== "llm";

  if (!lowPressure) {
    return false;
  }

  if (item.seriousness === "low") {
    return hoursOverdue >= thresholds.lowHours;
  }

  if (item.seriousness === "medium") {
    return hoursOverdue >= thresholds.mediumHours && (item.alert_count ?? 0) >= 1;
  }

  return false;
}

// ─── Main sweep ──────────────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  // Concurrency guard — prevent overlapping sweeps from sending duplicates
  if (sweepInProgress) {
    log.debug("Sweep already in progress, skipping");
    return;
  }
  sweepInProgress = true;
  let advisoryLockAcquired = false;

  try {
    advisoryLockAcquired = await tryAcquireSweepLock();
    if (!advisoryLockAcquired) {
      log.debug("Sweep already running on another instance, skipping");
      return;
    }

    // ── Step 1: Auto-expire stale follow-ups ──
    const maxAgeMs = config.FOLLOW_UP_MAX_AGE_HOURS * 60 * 60 * 1000;
    const expiredCount = await db.expireStaleFollowUpItems(maxAgeMs);
    if (expiredCount > 0) {
      log.info({ expiredCount, maxAgeHours: config.FOLLOW_UP_MAX_AGE_HOURS }, "Auto-expired stale follow-up items");
    }

    // ── Step 2: Reconcile missed items ──
    await reconcileMissingFollowUps({
      limit: 500,
    });

    // ── Step 2b: Surface items once the reply grace window has elapsed ──
    const pendingItems = await db.listVisiblePendingFollowUpItems(100);
    for (const item of pendingItems) {
      const nextState =
        item.primary_responder_ids.length === 0 &&
        item.escalation_responder_ids.length > 0
          ? "escalated"
          : "awaiting_primary";
      if (nextState === "escalated") {
        await db.escalateFollowUpItem({
          itemId: item.id,
          primaryMissedSla: false,
        });
        await db.recordFollowUpEvent({
          followUpItemId: item.id,
          workspaceId: item.workspace_id,
          channelId: item.channel_id,
          eventType: "escalated",
          workflowState: "escalated",
          metadata: {
            promotedFrom: "pending_reply_window",
            seniorOwnedFromStart: true,
          },
        });
      } else {
        await db.promoteFollowUpVisibility(item.id, "awaiting_primary");
      }

      emitFollowUpAlert({
        workspaceId: item.workspace_id,
        channelId: item.channel_id,
        followUpItemId: item.id,
        alertType:
          item.seriousness === "high"
            ? "follow_up_high_priority"
            : "follow_up_opened",
        changeType: nextState === "escalated" ? "escalated" : "created",
        seriousness: item.seriousness,
        sourceMessageTs: item.source_message_ts,
        threadTs: item.source_thread_ts,
        summary:
          nextState === "escalated"
            ? "No primary owner was resolved, so this follow-up routed directly to senior coverage."
            : item.summary,
      });
    }

    // ── Step 3: Fetch due items and apply escalation curve ──
    const baseRepeatMs =
      config.FOLLOW_UP_ALERT_REPEAT_HOURS * 60 * 60 * 1000;
    const dueItems = await db.listDueFollowUpItems(100, baseRepeatMs);

    // Escalation curve: increase repeat interval based on how many nudges have been sent.
    // Nudges 1-3: every 6h (1x), 4-6: every 12h (2x), 7-9: every 24h (4x), 10-12: every 48h (8x)
    const now = Date.now();
    const eligibleItems = dueItems.filter((item) => {
      if (!item.last_alerted_at) return true;
      const alertCount = item.alert_count ?? 0;
      const escalationFactor = Math.pow(2, Math.floor(alertCount / 3));
      const effectiveThreshold = baseRepeatMs * Math.min(escalationFactor, 8);
      const elapsed = now - new Date(item.last_alerted_at).getTime();
      return elapsed >= effectiveThreshold;
    });

    if (eligibleItems.length === 0) {
      log.debug("No due follow-up items found");
    } else {
      log.info(
        { total: dueItems.length, eligible: eligibleItems.length },
        "Found due follow-up items to process",
      );
    }

    for (const item of eligibleItems) {
      const hoursOverdue = getHoursOverdue(item);
      const scored = scoreOverdueItem(item);
      const seriousnessChanged = scored.seriousness !== item.seriousness;
      const firstDueAlert = (item.alert_count ?? 0) === 0;
      const currentAlertCount = item.alert_count ?? 0;

      // Check if Slack DM notifications are allowed
      const [policy, confirmedAssignments] = await Promise.all([
        db.getFollowUpRule(item.workspace_id, item.channel_id),
        db.listConfirmedRoleAssignments(item.workspace_id),
      ]);
      const conversationType = policy?.conversation_type ?? "public_channel";
      const privacyAllowed =
        conversationType === "public_channel" ||
        Boolean(policy?.privacy_opt_in);

      if (
        !privacyAllowed ||
        policy?.enabled === false ||
        policy?.muted
      ) {
        continue;
      }

      if (shouldQuietlyConclude(item, hoursOverdue)) {
        await clearFollowUpReminderDms(item.workspace_id, item.id);
        await db.resolveFollowUpItem({
          itemId: item.id,
          resolvedMessageTs: null,
          resolutionReason: "natural_conclusion",
          resolutionScope: "system",
          lastEngagementAt: new Date(),
        });
        await db.recordFollowUpEvent({
          followUpItemId: item.id,
          workspaceId: item.workspace_id,
          channelId: item.channel_id,
          eventType: "resolved",
          workflowState: "resolved",
          metadata: {
            resolutionReason: "natural_conclusion",
          },
        });
        emitFollowUpAlert({
          workspaceId: item.workspace_id,
          channelId: item.channel_id,
          followUpItemId: item.id,
          alertType: "follow_up_resolved",
          changeType: "resolved",
          seriousness: item.seriousness,
          sourceMessageTs: item.source_message_ts,
          threadTs: item.source_thread_ts,
          summary: "Closed after extended silence with no visible response.",
          resolutionReason: "natural_conclusion",
          engagementScope: "system",
          lastEngagementAt: new Date().toISOString(),
        });
        continue;
      }

      const shouldEscalate =
        item.workflow_state !== "escalated" &&
        item.escalation_responder_ids.length > 0 &&
        (
          !item.acknowledged_at ||
          item.repeated_ask_count > 1 ||
          item.ignored_score >= config.FOLLOW_UP_IGNORE_SCORE_THRESHOLD ||
          item.seriousness === "high"
        );

      if (shouldEscalate) {
        await db.escalateFollowUpItem({
          itemId: item.id,
          primaryMissedSla: true,
        });
        await db.recordFollowUpEvent({
          followUpItemId: item.id,
          workspaceId: item.workspace_id,
          channelId: item.channel_id,
          eventType: "escalated",
          workflowState: "escalated",
          metadata: {
            ignoredScore: item.ignored_score,
            repeatedAskCount: item.repeated_ask_count,
          },
        });
        emitFollowUpAlert({
          workspaceId: item.workspace_id,
          channelId: item.channel_id,
          followUpItemId: item.id,
          alertType: "follow_up_due",
          changeType: "escalated",
          seriousness: scored.seriousness,
          sourceMessageTs: item.source_message_ts,
          threadTs: item.source_thread_ts,
          summary: "Primary lane missed the reply window, so this follow-up has been escalated to senior coverage.",
        });
        item.workflow_state = "escalated";
      }

      if (
        scored.seriousness !== item.seriousness ||
        scored.score !== item.seriousness_score
      ) {
        await db.updateFollowUpSeverity(
          item.id,
          scored.seriousness,
          scored.score,
          scored.summary,
        );
      }

      emitFollowUpAlert({
        workspaceId: item.workspace_id,
        channelId: item.channel_id,
        followUpItemId: item.id,
        alertType: "follow_up_due",
        changeType: seriousnessChanged
          ? "severity_changed"
          : firstDueAlert
            ? "due"
            : "updated",
        seriousness: scored.seriousness,
        sourceMessageTs: item.source_message_ts,
        threadTs: item.source_thread_ts,
        summary: scored.summary,
      });

      if (currentAlertCount >= config.FOLLOW_UP_MAX_NUDGE_COUNT) {
        await db.markFollowUpAlerted(item.id);
        log.debug({ itemId: item.id, alertCount: currentAlertCount }, "Nudge cap reached, skipping DM");
        continue;
      }

      if (policy?.slack_notifications_enabled === false) {
        await db.markFollowUpAlerted(item.id);
        continue;
      }

      const confirmedRoles = new Map(
        confirmedAssignments.map((assignment) => [
          assignment.user_id,
          assignment.role,
        ]),
      );
      const mentionIds = resolveSlackReminderTargets(
        item.primary_responder_ids,
        item.escalation_responder_ids,
        item.workflow_state,
        policy?.owner_user_ids,
        policy?.senior_user_ids,
        confirmedRoles,
        item.requester_user_id,
      );

      if (mentionIds.length === 0) {
        log.warn(
          {
            channelId: item.channel_id,
            requester: item.requester_user_id,
            rolesFound: confirmedRoles.size,
          },
          "Follow-up DM skipped — no target users resolved (check role_assignments)",
        );
        continue;
      }

      await clearFollowUpReminderDms(item.workspace_id, item.id);

      // Build the DM message using Block Kit for reliable notifications
      const channelName = item.channel_name ?? item.channel_id;
      const notificationText = `Follow-up reminder: ${scored.summary}`;
      const dmBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Follow-up reminder* from *#${channelName}*\n${scored.summary}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `_Nudge ${(item.alert_count ?? 0) + 1} · This message will be replaced on the next check._`,
            },
          ],
        },
      ];

      // Send personal DMs to each target user
      const newDmRefs: DmRef[] = [];
      let dmSentCount = 0;
      try {
        const slack = await getSlackClient(item.workspace_id);
        const botUserId = slack.getBotUserId();

        for (const userId of mentionIds) {
          if (userId === botUserId) {
            log.warn({ userId }, "Skipping follow-up DM to bot itself");
            continue;
          }
          try {
            const dmChannelId = await slack.openDM(userId);
            const result = await slack.postSlackMessage({
              channelId: dmChannelId,
              text: notificationText,
              blocks: dmBlocks,
            });

            if (result.ts) {
              newDmRefs.push({
                userId,
                dmChannelId,
                messageTs: result.ts,
              });
            }
            dmSentCount++;
            log.info(
              { userId, channelId: item.channel_id, dmChannelId, messageTs: result.ts },
              "Follow-up DM sent successfully",
            );
          } catch (err) {
            log.warn(
              { err, userId, channelId: item.channel_id },
              "Failed to DM follow-up reminder to user",
            );
          }
        }
      } catch (err) {
        log.warn(
          { err, channelId: item.channel_id },
          "Failed to get Slack client for follow-up DM",
        );
      }

      if (dmSentCount > 0) {
        await db.markFollowUpAlerted(item.id, newDmRefs);
        log.info(
          { itemId: item.id, dmSentCount, targets: mentionIds },
          "Follow-up DMs sent and marked alerted",
        );
      } else {
        log.warn(
          { itemId: item.id, targets: mentionIds },
          "All follow-up DM attempts failed",
        );
      }
    }

    if (eligibleItems.length > 0) {
      log.debug({ processed: eligibleItems.length }, "Processed follow-up reminders");
    }
  } finally {
    sweepInProgress = false;
    if (advisoryLockAcquired) {
      try {
        await releaseSweepLock();
      } catch (err) {
        log.warn({ err }, "Failed to release follow-up sweep advisory lock");
      }
    }
  }
}

export function startFollowUpSweep(): void {
  if (timer) return;

  const run = () => {
    runSweep().catch((err) => {
      log.error({ err }, "Follow-up sweep failed");
    });
  };

  timer = setInterval(run, config.FOLLOW_UP_SWEEP_MS);
  timer.unref();
  run();
}

export function stopFollowUpSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
