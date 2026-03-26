import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { eventBus } from "./eventBus.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { MessageAnalysis, ThreadAnalysis } from "./emotionAnalyzer.js";
import type { ChannelClassificationType, UserRole } from "../types/database.js";

const alertLog = logger.child({ module: "alerting", severity: "alert" });

interface AlertContext {
  workspaceId: string;
  channelId: string;
  messageTs?: string;
  threadTs?: string;
  /** Channel classification — used to adjust alert thresholds */
  channelType?: ChannelClassificationType | null;
}

// ─── Sentiment Alert DM throttle ────────────────────────────────────────────
// Prevent spamming DMs for the same channel within a short window.
const ALERT_DM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per channel
const ALERT_DM_AUTO_DELETE_MS = 20 * 60 * 1000; // auto-delete after 20 min
const lastAlertDmAt = new Map<string, number>();

// ─── Classification-aware threshold configuration ─────────────────────────
// Per-channel-type alert behavior. Client channels are strict, internal relaxed, social disabled.
type AlertSeverity = "info" | "warning" | "critical";

interface ChannelAlertPolicy {
  /** Whether sentiment alerts fire at all for this channel type */
  sentimentAlertsEnabled: boolean;
  /** Minimum confidence for anger alerts (higher = fewer false positives) */
  angerConfidenceThreshold: number;
  /** Minimum confidence for sarcasm alerts */
  sarcasmConfidenceThreshold: number;
  /** Severity boost: how alerts from this channel type should be classified */
  escalationSeverity: AlertSeverity;
  /** Whether deteriorating sentiment should alert */
  deterioratingEnabled: boolean;
  /** DM cooldown override in ms (longer for internal channels) */
  dmCooldownMs: number;
}

const CHANNEL_ALERT_POLICIES: Record<string, ChannelAlertPolicy> = {
  client_delivery: {
    sentimentAlertsEnabled: true,
    angerConfidenceThreshold: 0.75, // lower threshold = catch more (client matters)
    sarcasmConfidenceThreshold: 0.70,
    escalationSeverity: "critical",
    deterioratingEnabled: true,
    dmCooldownMs: 3 * 60 * 1000, // 3 min (urgent for client channels)
  },
  client_support: {
    sentimentAlertsEnabled: true,
    angerConfidenceThreshold: 0.70,
    sarcasmConfidenceThreshold: 0.70,
    escalationSeverity: "critical",
    deterioratingEnabled: true,
    dmCooldownMs: 3 * 60 * 1000,
  },
  internal_engineering: {
    sentimentAlertsEnabled: true,
    angerConfidenceThreshold: 0.90, // higher threshold = fewer alerts (internal banter is noisy)
    sarcasmConfidenceThreshold: 0.90,
    escalationSeverity: "warning",
    deterioratingEnabled: true,
    dmCooldownMs: 10 * 60 * 1000, // 10 min
  },
  internal_operations: {
    sentimentAlertsEnabled: true,
    angerConfidenceThreshold: 0.90,
    sarcasmConfidenceThreshold: 0.90,
    escalationSeverity: "warning",
    deterioratingEnabled: true,
    dmCooldownMs: 10 * 60 * 1000,
  },
  internal_social: {
    sentimentAlertsEnabled: false, // disable alerts for #general, #random
    angerConfidenceThreshold: 1.0,
    sarcasmConfidenceThreshold: 1.0,
    escalationSeverity: "info",
    deterioratingEnabled: false,
    dmCooldownMs: 30 * 60 * 1000,
  },
  automated: {
    sentimentAlertsEnabled: false, // bot channels don't need sentiment alerts
    angerConfidenceThreshold: 1.0,
    sarcasmConfidenceThreshold: 1.0,
    escalationSeverity: "info",
    deterioratingEnabled: false,
    dmCooldownMs: 60 * 60 * 1000,
  },
};

const DEFAULT_ALERT_POLICY: ChannelAlertPolicy = {
  sentimentAlertsEnabled: true,
  angerConfidenceThreshold: 0.85,
  sarcasmConfidenceThreshold: 0.80,
  escalationSeverity: "warning",
  deterioratingEnabled: true,
  dmCooldownMs: ALERT_DM_COOLDOWN_MS,
};

function getAlertPolicy(channelType?: ChannelClassificationType | null): ChannelAlertPolicy {
  if (channelType && channelType in CHANNEL_ALERT_POLICIES) {
    return CHANNEL_ALERT_POLICIES[channelType];
  }
  return DEFAULT_ALERT_POLICY;
}

// ─── Alert deduplication ────────────────────────────────────────────────────
// Prevent the same alert type from firing for the same channel within a window.
const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 min
const recentAlerts = new Map<string, number>();

function isDuplicateAlert(workspaceId: string, channelId: string, alertType: string): boolean {
  const key = `${workspaceId}:${channelId}:${alertType}`;
  const lastFired = recentAlerts.get(key);
  if (lastFired && Date.now() - lastFired < ALERT_DEDUP_WINDOW_MS) {
    return true;
  }
  recentAlerts.set(key, Date.now());
  // Prune old entries when map grows beyond reasonable bounds
  if (recentAlerts.size > 200) {
    const cutoff = Date.now() - ALERT_DEDUP_WINDOW_MS;
    for (const [k, v] of recentAlerts) {
      if (v < cutoff) recentAlerts.delete(k);
    }
  }
  return false;
}

/**
 * Checks analysis results against alert thresholds and emits structured log events.
 * Classification-aware: thresholds vary by channel type (client = strict, social = disabled).
 */
export function checkAndAlert(
  analysis: MessageAnalysis | ThreadAnalysis,
  context: AlertContext,
): void {
  const policy = getAlertPolicy(context.channelType);

  // Short-circuit: alerts disabled for this channel type
  if (!policy.sentimentAlertsEnabled) {
    return;
  }

  const interactionTone = analysis.interaction_tone ?? "neutral";

  const fireAlert = (alertType: string, severity: AlertSeverity, extra: Record<string, unknown>) => {
    // Deduplicate: same alert type + channel within window
    if (isDuplicateAlert(context.workspaceId, context.channelId, alertType)) {
      alertLog.debug({ alertType, channelId: context.channelId }, "Alert deduplicated (recent duplicate)");
      return;
    }

    alertLog.warn({ alertType, severity, channelType: context.channelType, ...context, ...extra }, `Alert: ${alertType}`);
    eventBus.createAndPublish("alert_triggered", context.workspaceId, context.channelId, {
      alertType,
      severity,
      channelType: context.channelType ?? "unclassified",
      changeType: "created",
      sourceMessageTs: context.messageTs ?? null,
      threadTs: context.threadTs ?? null,
      ...extra,
    });
  };

  // Alert 1: High escalation risk
  if (analysis.escalation_risk === "high") {
    fireAlert("high_escalation_risk", policy.escalationSeverity, {
      emotion: analysis.dominant_emotion,
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 2: High-confidence anger (threshold varies by channel type)
  if (
    analysis.dominant_emotion === "anger" &&
    analysis.confidence > policy.angerConfidenceThreshold &&
    interactionTone !== "corrective"
  ) {
    fireAlert("high_confidence_anger", policy.escalationSeverity, {
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 3: Sarcasm masking anger (threshold varies by channel type)
  if (
    analysis.sarcasm_detected &&
    analysis.intended_emotion === "anger" &&
    analysis.confidence > policy.sarcasmConfidenceThreshold
  ) {
    fireAlert("sarcasm_masked_anger", policy.escalationSeverity, {
      surfaceEmotion: analysis.dominant_emotion,
      intendedEmotion: analysis.intended_emotion,
      interactionTone,
      confidence: analysis.confidence,
      explanation: analysis.explanation,
    });
  }

  // Alert 4: Deteriorating thread sentiment
  if (
    policy.deterioratingEnabled &&
    "sentiment_trajectory" in analysis &&
    analysis.sentiment_trajectory === "deteriorating"
  ) {
    fireAlert("deteriorating_sentiment", policy.escalationSeverity, {
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
  const { workspaceId, channelId, channelType } = context;
  const throttleKey = `${workspaceId}:${channelId}`;
  const policy = getAlertPolicy(channelType);

  // Suppress DMs for channels with alerts disabled
  if (!policy.sentimentAlertsEnabled) return;

  // Per-channel cooldown (varies by channel type)
  const lastSent = lastAlertDmAt.get(throttleKey);
  if (lastSent && Date.now() - lastSent < policy.dmCooldownMs) {
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
            } catch (err) {
              logger.debug({ err: err instanceof Error ? err.message : "unknown", dmChannelId }, "Auto-delete DM failed (best-effort)");
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
