/**
 * Analytics Engine — anomaly detection, per-channel health scoring,
 * and trajectory analysis built on existing sentiment trend data.
 *
 * Approach: statistical (no LLM calls). Uses rolling baselines + z-score deviation.
 * Runs periodically via the intelligence reconcile loop.
 */

import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { eventBus } from "./eventBus.js";

const log = logger.child({ service: "analyticsEngine" });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelHealthScore {
  channelId: string;
  score: number; // 0-100 (100 = healthy)
  health: "healthy" | "attention" | "at-risk";
  trajectory: "improving" | "stable" | "degrading";
  drivers: HealthDriver[];
  computedAt: string;
}

export interface HealthDriver {
  signal: string;
  impact: number; // 0-100, how much this factor hurts health
  description: string;
}

export interface AnomalyEvent {
  channelId: string;
  metric: string;
  expectedValue: number;
  actualValue: number;
  deviationSigma: number;
  direction: "above" | "below";
  description: string;
  detectedAt: string;
}

// ─── Statistical helpers ────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg?: number): number {
  if (values.length < 2) return 0;
  const m = avg ?? mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function zScore(value: number, avg: number, sd: number): number {
  if (sd === 0) return 0;
  return (value - avg) / sd;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Sentiment score from emotion distribution ──────────────────────────────

const EMOTION_WEIGHTS: Record<string, number> = {
  anger: 0.0,
  disgust: 0.1,
  fear: 0.2,
  sadness: 0.25,
  neutral: 0.55,
  surprise: 0.6,
  joy: 1.0,
};

function emotionToSentiment(emotionCounts: Record<string, number>): number {
  let weightedSum = 0;
  let total = 0;
  for (const [emotion, count] of Object.entries(emotionCounts)) {
    const weight = EMOTION_WEIGHTS[emotion] ?? 0.5;
    weightedSum += weight * count;
    total += count;
  }
  return total > 0 ? weightedSum / total : 0.55; // default neutral
}

// ─── Per-channel health scoring ─────────────────────────────────────────────

/**
 * Computes a health score (0-100) for a single channel using multiple signals.
 * Higher score = healthier. Drivers explain why the score is what it is.
 */
export async function computeChannelHealth(
  workspaceId: string,
  channelId: string,
): Promise<ChannelHealthScore> {
  const now = new Date();
  const drivers: HealthDriver[] = [];
  let penalty = 0;

  // Fetch parallel data
  const [
    trends7d,
    trends14d,
    openFollowUps,
    classification,
  ] = await Promise.all([
    db.getSentimentTrends(workspaceId, {
      channelId,
      granularity: "daily",
      from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      limit: 7,
    }),
    db.getSentimentTrends(workspaceId, {
      channelId,
      granularity: "daily",
      from: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      limit: 14,
    }),
    db.listOpenFollowUpItems(workspaceId, 50),
    db.getChannelClassification(workspaceId, channelId),
  ]);

  const channelFollowUps = openFollowUps.filter((f) => f.channel_id === channelId);
  const channelType = classification?.channel_type ?? "unclassified";

  // ── Signal 1: Negative sentiment ratio (last 7 days) ──
  const recentBuckets = trends7d;
  if (recentBuckets.length > 0) {
    const totalMessages = recentBuckets.reduce((s, b) => s + b.total, 0);
    const negativeMessages = recentBuckets.reduce(
      (s, b) => s + (b.emotions?.anger ?? 0) + (b.emotions?.disgust ?? 0) + (b.emotions?.fear ?? 0) + (b.emotions?.sadness ?? 0),
      0,
    );
    const negRatio = totalMessages > 0 ? negativeMessages / totalMessages : 0;

    if (negRatio > 0.30) {
      const impact = Math.round(negRatio * 80);
      penalty += impact;
      drivers.push({
        signal: "high_negative_sentiment",
        impact,
        description: `${Math.round(negRatio * 100)}% of messages have negative sentiment (last 7 days)`,
      });
    } else if (negRatio > 0.15) {
      const impact = Math.round(negRatio * 40);
      penalty += impact;
      drivers.push({
        signal: "elevated_negative_sentiment",
        impact,
        description: `${Math.round(negRatio * 100)}% of messages have negative sentiment`,
      });
    }

    // High escalation risk count
    const highRiskCount = recentBuckets.reduce((s, b) => s + (b.highRiskCount ?? 0), 0);
    if (highRiskCount >= 3) {
      const impact = Math.min(30, highRiskCount * 8);
      penalty += impact;
      drivers.push({
        signal: "escalation_risk",
        impact,
        description: `${highRiskCount} high-risk messages in the last 7 days`,
      });
    }
  }

  // ── Signal 2: Open follow-ups ──
  const highSevFollowUps = channelFollowUps.filter((f) => f.seriousness === "high");
  const overdueFollowUps = channelFollowUps.filter(
    (f) => f.due_at && new Date(f.due_at) < now,
  );

  if (overdueFollowUps.length > 0) {
    const impact = Math.min(25, overdueFollowUps.length * 10);
    penalty += impact;
    drivers.push({
      signal: "overdue_follow_ups",
      impact,
      description: `${overdueFollowUps.length} overdue follow-up item(s)`,
    });
  }

  if (highSevFollowUps.length > 0) {
    const impact = Math.min(15, highSevFollowUps.length * 5);
    penalty += impact;
    drivers.push({
      signal: "high_severity_follow_ups",
      impact,
      description: `${highSevFollowUps.length} high-severity open follow-up(s)`,
    });
  }

  // ── Signal 3: Meeting obligation overdue (if Fathom data exists) ──
  try {
    const { obligations } = await db.listMeetingObligations(workspaceId, { channelId, status: "open", limit: 50 });
    const overdueObligations = obligations.filter(
      (o) => o.due_date && new Date(o.due_date) < now,
    );
    if (overdueObligations.length > 0) {
      const impact = Math.min(20, overdueObligations.length * 8);
      penalty += impact;
      drivers.push({
        signal: "overdue_meeting_commitments",
        impact,
        description: `${overdueObligations.length} overdue meeting commitment(s)`,
      });
    }
  } catch {
    // Meeting tables may not exist yet — non-fatal
  }

  // ── Signal 4: Channel type weighting ──
  // Client channels get harsher penalties (risk matters more)
  if (channelType === "client_delivery" || channelType === "client_support") {
    penalty = Math.round(penalty * 1.3); // 30% amplification for client channels
  } else if (channelType === "internal_social") {
    penalty = Math.round(penalty * 0.3); // 70% dampening for social channels
  }

  // ── Compute trajectory (compare last 7d vs prior 7d) ──
  let trajectory: "improving" | "stable" | "degrading" = "stable";
  if (trends14d.length >= 7) {
    const midpoint = Math.floor(trends14d.length / 2);
    const olderBuckets = trends14d.slice(0, midpoint);
    const newerBuckets = trends14d.slice(midpoint);

    const olderSentiment = mean(
      olderBuckets.map((b) => emotionToSentiment(b.emotions ?? {})),
    );
    const newerSentiment = mean(
      newerBuckets.map((b) => emotionToSentiment(b.emotions ?? {})),
    );

    const delta = newerSentiment - olderSentiment;
    if (delta > 0.08) trajectory = "improving";
    else if (delta < -0.08) trajectory = "degrading";
  }

  // If trajectory is degrading, add a driver
  if (trajectory === "degrading") {
    const impact = 10;
    penalty += impact;
    drivers.push({
      signal: "sentiment_trajectory_down",
      impact,
      description: "Sentiment trending downward compared to prior week",
    });
  }

  const score = clamp(100 - penalty, 0, 100);
  const health: "healthy" | "attention" | "at-risk" =
    score >= 70 ? "healthy" : score >= 40 ? "attention" : "at-risk";

  // Sort drivers by impact (highest first)
  drivers.sort((a, b) => b.impact - a.impact);

  return {
    channelId,
    score,
    health,
    trajectory,
    drivers: drivers.slice(0, 5), // Top 5 drivers
    computedAt: now.toISOString(),
  };
}

// ─── Anomaly Detection ──────────────────────────────────────────────────────

/**
 * Detects anomalies in a channel by comparing the latest day's metrics
 * against a 30-day rolling baseline using z-scores.
 *
 * An anomaly is flagged when the z-score exceeds the threshold (default: 2σ).
 */
export async function detectAnomalies(
  workspaceId: string,
  channelId: string,
  options: { sigmaThreshold?: number } = {},
): Promise<AnomalyEvent[]> {
  const threshold = options.sigmaThreshold ?? 2.0;
  const now = new Date();
  const anomalies: AnomalyEvent[] = [];

  // Fetch 30 days of daily trends
  const trends = await db.getSentimentTrends(workspaceId, {
    channelId,
    granularity: "daily",
    from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    limit: 30,
  });

  if (trends.length < 7) {
    // Not enough data for meaningful baselines
    return anomalies;
  }

  // Split into baseline (all but last) and latest
  const baseline = trends.slice(0, -1);
  const latest = trends[trends.length - 1];
  if (!latest) return anomalies;

  // ── Check 1: Total message volume anomaly ──
  const baselineVolumes = baseline.map((b) => b.total);
  const avgVolume = mean(baselineVolumes);
  const sdVolume = stddev(baselineVolumes, avgVolume);
  const volumeZ = zScore(latest.total, avgVolume, sdVolume);

  if (Math.abs(volumeZ) > threshold && sdVolume > 0) {
    anomalies.push({
      channelId,
      metric: "message_volume",
      expectedValue: Math.round(avgVolume),
      actualValue: latest.total,
      deviationSigma: Math.round(volumeZ * 100) / 100,
      direction: volumeZ > 0 ? "above" : "below",
      description: volumeZ > 0
        ? `Message volume spiked to ${latest.total} (expected ~${Math.round(avgVolume)}, ${Math.abs(Math.round(volumeZ * 10) / 10)}σ above normal)`
        : `Message volume dropped to ${latest.total} (expected ~${Math.round(avgVolume)}, ${Math.abs(Math.round(volumeZ * 10) / 10)}σ below normal)`,
      detectedAt: now.toISOString(),
    });
  }

  // ── Check 2: Negative sentiment ratio anomaly ──
  const baselineNegRatios = baseline.map((b) => {
    const neg = (b.emotions?.anger ?? 0) + (b.emotions?.disgust ?? 0) + (b.emotions?.fear ?? 0) + (b.emotions?.sadness ?? 0);
    return b.total > 0 ? neg / b.total : 0;
  });
  const latestNeg = (latest.emotions?.anger ?? 0) + (latest.emotions?.disgust ?? 0) + (latest.emotions?.fear ?? 0) + (latest.emotions?.sadness ?? 0);
  const latestNegRatio = latest.total > 0 ? latestNeg / latest.total : 0;
  const avgNegRatio = mean(baselineNegRatios);
  const sdNegRatio = stddev(baselineNegRatios, avgNegRatio);
  const negZ = zScore(latestNegRatio, avgNegRatio, sdNegRatio);

  if (negZ > threshold && sdNegRatio > 0) {
    anomalies.push({
      channelId,
      metric: "negative_sentiment_ratio",
      expectedValue: Math.round(avgNegRatio * 100),
      actualValue: Math.round(latestNegRatio * 100),
      deviationSigma: Math.round(negZ * 100) / 100,
      direction: "above",
      description: `Negative sentiment ratio jumped to ${Math.round(latestNegRatio * 100)}% (baseline ~${Math.round(avgNegRatio * 100)}%, ${Math.round(negZ * 10) / 10}σ above normal)`,
      detectedAt: now.toISOString(),
    });
  }

  // ── Check 3: High escalation risk spike ──
  const baselineHighRisk = baseline.map((b) => b.highRiskCount ?? 0);
  const avgHighRisk = mean(baselineHighRisk);
  const sdHighRisk = stddev(baselineHighRisk, avgHighRisk);
  const highRiskZ = zScore(latest.highRiskCount ?? 0, avgHighRisk, sdHighRisk);

  if (highRiskZ > threshold && sdHighRisk > 0 && (latest.highRiskCount ?? 0) >= 2) {
    anomalies.push({
      channelId,
      metric: "high_risk_messages",
      expectedValue: Math.round(avgHighRisk * 10) / 10,
      actualValue: latest.highRiskCount ?? 0,
      deviationSigma: Math.round(highRiskZ * 100) / 100,
      direction: "above",
      description: `${latest.highRiskCount} high-risk messages today (baseline ~${Math.round(avgHighRisk * 10) / 10}/day, ${Math.round(highRiskZ * 10) / 10}σ above normal)`,
      detectedAt: now.toISOString(),
    });
  }

  return anomalies;
}

// ─── Anomaly → Alert integration ────────────────────────────────────────────

/**
 * Runs anomaly detection for a channel and fires alerts for significant anomalies.
 */
export async function checkAndAlertAnomalies(
  workspaceId: string,
  channelId: string,
): Promise<AnomalyEvent[]> {
  const anomalies = await detectAnomalies(workspaceId, channelId);

  for (const anomaly of anomalies) {
    log.warn(
      {
        workspaceId,
        channelId,
        metric: anomaly.metric,
        deviationSigma: anomaly.deviationSigma,
        actualValue: anomaly.actualValue,
        expectedValue: anomaly.expectedValue,
      },
      `Anomaly detected: ${anomaly.description}`,
    );

    eventBus.createAndPublish("alert_triggered", workspaceId, channelId, {
      alertType: "anomaly_detected",
      severity: anomaly.deviationSigma > 3 ? "critical" : "warning",
      changeType: "created",
      metric: anomaly.metric,
      description: anomaly.description,
      deviationSigma: anomaly.deviationSigma,
    });
  }

  return anomalies;
}

// ─── Batch health computation ───────────────────────────────────────────────

/**
 * Computes health scores for all ready channels in a workspace.
 * Called periodically (daily) from the reconcile loop.
 */
export async function computeWorkspaceHealth(
  workspaceId: string,
): Promise<ChannelHealthScore[]> {
  const channels = await db.getReadyChannels();
  const workspaceChannels = channels.filter((c) => c.workspace_id === workspaceId);
  const scores: ChannelHealthScore[] = [];

  for (const channel of workspaceChannels) {
    try {
      const score = await computeChannelHealth(workspaceId, channel.channel_id);
      scores.push(score);

      // Persist health to channel_state
      await db.upsertChannelState(workspaceId, channel.channel_id, {
        health: score.health,
        signal: score.trajectory === "degrading" ? "escalating" : score.trajectory === "improving" ? "stable" : "elevated",
        signal_confidence: score.score / 100,
        risk_drivers_json: score.drivers.map((d) => ({
          key: d.signal,
          label: d.signal.replace(/_/g, " "),
          message: d.description,
          severity: (d.impact > 20 ? "high" : d.impact > 10 ? "medium" : "low") as "high" | "medium" | "low",
          category: "operational" as const,
        })),
      });

      // Run anomaly detection
      await checkAndAlertAnomalies(workspaceId, channel.channel_id);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : "unknown", channelId: channel.channel_id },
        "Failed to compute channel health",
      );
    }
  }

  log.info(
    {
      workspaceId,
      channelCount: scores.length,
      atRisk: scores.filter((s) => s.health === "at-risk").length,
      attention: scores.filter((s) => s.health === "attention").length,
      healthy: scores.filter((s) => s.health === "healthy").length,
    },
    "Workspace health computation complete",
  );

  return scores;
}
