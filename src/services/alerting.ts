import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { eventBus } from "./eventBus.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { MessageAnalysis, ThreadAnalysis } from "./emotionAnalyzer.js";
import type { UserRole } from "../types/database.js";

const alertLog = logger.child({ module: "alerting", severity: "alert" });

interface AlertContext {
  workspaceId: string;
  channelId: string;
  messageTs?: string;
  threadTs?: string;
}

// ─── Sentiment Alert DM throttle ────────────────────────────────────────────
// Prevent spamming DMs for the same channel within a short window.
const ALERT_DM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per channel
const ALERT_DM_AUTO_DELETE_MS = 20 * 60 * 1000; // auto-delete after 20 min
const lastAlertDmAt = new Map<string, number>();

/**
 * Checks analysis results against alert thresholds and emits structured log events.
 * MVP: alerts are structured pino log entries; future phases can add Slack/webhook delivery.
 */
export function checkAndAlert(
  analysis: MessageAnalysis | ThreadAnalysis,
  context: AlertContext,
): void {
  const interactionTone = analysis.interaction_tone ?? "neutral";

  const fireAlert = (alertType: string, extra: Record<string, unknown>) => {
    alertLog.warn({ alertType, ...context, ...extra }, `Alert: ${alertType}`);
    eventBus.createAndPublish("alert_triggered", context.workspaceId, context.channelId, {
      alertType,
      changeType: "created",
      sourceMessageTs: context.messageTs ?? null,
      threadTs: context.threadTs ?? null,
      ...extra,
    });
  };

  // Alert 1: High escalation risk
  if (analysis.escalation_risk === "high") {
    fireAlert("high_escalation_risk", {
      emotion: analysis.dominant_emotion,
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 2: High-confidence anger
  if (
    analysis.dominant_emotion === "anger" &&
    analysis.confidence > 0.85 &&
    interactionTone !== "corrective"
  ) {
    fireAlert("high_confidence_anger", {
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 3: Sarcasm masking anger — surface tone hides real frustration
  if (
    analysis.sarcasm_detected &&
    analysis.intended_emotion === "anger" &&
    analysis.confidence > 0.8
  ) {
    fireAlert("sarcasm_masked_anger", {
      surfaceEmotion: analysis.dominant_emotion,
      intendedEmotion: analysis.intended_emotion,
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 4: Deteriorating thread sentiment (thread analysis only)
  if ("sentiment_trajectory" in analysis && analysis.sentiment_trajectory === "deteriorating") {
    fireAlert("deteriorating_sentiment", {
      threadSentiment: analysis.thread_sentiment,
      summary: analysis.summary,
    });
  }
}

/**
 * Emits a budget exceeded alert.
 */
export function alertBudgetExceeded(
  workspaceId: string,
  dailyCost: number,
  budget: number,
): void {
  alertLog.warn(
    {
      alertType: "budget_exceeded",
      workspaceId,
      dailyCostUsd: dailyCost,
      budgetUsd: budget,
    },
    "Daily LLM budget exceeded, skipping analysis",
  );

  eventBus.createAndPublish("alert_triggered", workspaceId, "system", {
    alertType: "budget_exceeded",
    changeType: "created",
    dailyCostUsd: dailyCost,
    budgetUsd: budget,
  });
}

// ─── Sentiment Alert DMs ────────────────────────────────────────────────────

const ALERT_TYPE_LABELS: Record<string, string> = {
  high_escalation_risk: "High Escalation Risk",
  high_confidence_anger: "High-Confidence Anger",
  sarcasm_masked_anger: "Sarcasm Masking Anger",
  deteriorating_sentiment: "Deteriorating Sentiment",
};

function resolveAlertTargets(
  ownerIds: string[] | null | undefined,
  seniorIds: string[] | null | undefined,
  confirmedRoles: Map<string, UserRole>,
): string[] {
  const explicit = [...new Set([...(ownerIds ?? []), ...(seniorIds ?? [])])];
  if (explicit.length > 0) return explicit;

  return [...confirmedRoles.entries()]
    .filter(([, role]) => role === "worker" || role === "senior" || role === "client")
    .map(([userId]) => userId);
}

/**
 * Sends Slack DMs for sentiment alerts (high risk, anger, sarcasm, etc.).
 * Throttled per channel to avoid spamming. Fire-and-forget from the caller.
 */
export async function sendSentimentAlertDMs(
  context: AlertContext,
  alertType: string,
  extra: { explanation?: string; emotion?: string; confidence?: number },
): Promise<void> {
  const { workspaceId, channelId } = context;
  const throttleKey = `${workspaceId}:${channelId}`;

  // Per-channel cooldown
  const lastSent = lastAlertDmAt.get(throttleKey);
  if (lastSent && Date.now() - lastSent < ALERT_DM_COOLDOWN_MS) {
    alertLog.debug({ channelId, alertType }, "Sentiment alert DM skipped (cooldown)");
    return;
  }

  try {
    const [policy, confirmedAssignments, channel] = await Promise.all([
      db.getFollowUpRule(workspaceId, channelId),
      db.listConfirmedRoleAssignments(workspaceId),
      db.getChannel(workspaceId, channelId),
    ]);

    // Respect notification settings
    const conversationType = policy?.conversation_type ?? "public_channel";
    const privacyAllowed =
      conversationType === "public_channel" || Boolean(policy?.privacy_opt_in);

    if (!privacyAllowed || policy?.muted || policy?.slack_notifications_enabled === false) {
      alertLog.debug({ channelId, alertType }, "Sentiment alert DM skipped (notifications disabled)");
      return;
    }

    const confirmedRoles = new Map(
      confirmedAssignments.map((a) => [a.user_id, a.role]),
    );
    const targetIds = resolveAlertTargets(
      policy?.owner_user_ids,
      policy?.senior_user_ids,
      confirmedRoles,
    );

    if (targetIds.length === 0) {
      alertLog.debug({ channelId, alertType }, "Sentiment alert DM skipped (no targets)");
      return;
    }

    const channelName = channel?.name ?? channelId;
    const label = ALERT_TYPE_LABELS[alertType] ?? alertType;
    const explanation = extra.explanation
      ? `\n>${extra.explanation.slice(0, 200)}`
      : "";

    const notificationText = `${label} detected in #${channelName}`;
    const dmBlocks = [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: [`*${label}* detected in *#${channelName}*`, explanation].filter(Boolean).join("\n"),
        },
      },
      {
        type: "context" as const,
        elements: [
          { type: "mrkdwn" as const, text: `_This message will disappear in 20 minutes._` },
        ],
      },
    ];

    const slack = await getSlackClient(workspaceId);
    let sent = 0;

    for (const userId of targetIds) {
      try {
        const dmChannelId = await slack.openDM(userId);
        const result = await slack.postSlackMessage({
          channelId: dmChannelId,
          text: notificationText,
          blocks: dmBlocks,
        });

        if (result.ts) {
          // Schedule auto-delete
          setTimeout(async () => {
            try {
              const client = await getSlackClient(workspaceId);
              await client.deleteMessage(dmChannelId, result.ts!);
            } catch {
              // Best-effort deletion
            }
          }, ALERT_DM_AUTO_DELETE_MS).unref();
        }
        sent++;
      } catch (err) {
        alertLog.warn({ err, userId, channelId, alertType }, "Failed to DM sentiment alert to user");
      }
    }

    if (sent > 0) {
      lastAlertDmAt.set(throttleKey, Date.now());
      alertLog.info({ channelId, alertType, sentTo: sent }, "Sentiment alert DMs sent");
    }
  } catch (err) {
    alertLog.warn({ err, channelId, alertType }, "Failed to send sentiment alert DMs");
  }
}
