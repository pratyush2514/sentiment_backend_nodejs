import type {
  AttentionSummary,
  ChannelHealthCountsRow,
  ChannelMode,
  DominantEmotion,
  MessageDispositionCounts,
  RiskDriver,
} from "../types/database.js";

export type ChannelRiskSignal = "stable" | "elevated" | "escalating";
export type ChannelRiskHealth = "healthy" | "attention" | "at-risk";

export interface ChannelRiskCounts {
  analysisWindowDays: number;
  openAlertCount: number;
  highSeverityAlertCount: number;
  automationIncidentCount: number;
  criticalAutomationIncidentCount: number;
  automationIncident24hCount: number;
  criticalAutomationIncident24hCount: number;
  humanRiskSignalCount: number;
  requestSignalCount: number;
  decisionSignalCount: number;
  resolutionSignalCount: number;
  flaggedMessageCount: number;
  highRiskMessageCount: number;
  attentionThreadCount: number;
  blockedThreadCount: number;
  escalatedThreadCount: number;
  riskyThreadCount: number;
  totalMessageCount: number;
  skippedMessageCount: number;
  contextOnlyMessageCount: number;
  ignoredMessageCount: number;
  inflightMessageCount: number;
}

export interface ChannelRiskSnapshot {
  totalAnalyzed: number;
  highRiskCount: number;
  emotionDistribution: Record<DominantEmotion, number>;
}

export interface ChannelRiskState {
  healthCounts: ChannelRiskCounts;
  sentimentSnapshot: ChannelRiskSnapshot;
  signal: ChannelRiskSignal;
  health: ChannelRiskHealth;
  signalConfidence: number;
  negativeRatio: number;
  effectiveChannelMode: ChannelMode;
  riskDrivers: RiskDriver[];
  attentionSummary: AttentionSummary;
  messageDispositionCounts: MessageDispositionCounts;
}

function parseCount(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeNegativeRatio(snapshot: ChannelRiskSnapshot): number {
  const total = Object.values(snapshot.emotionDistribution).reduce(
    (sum, count) => sum + count,
    0,
  ) || 1;

  return (
    (snapshot.emotionDistribution.anger ?? 0) +
    (snapshot.emotionDistribution.sadness ?? 0) +
    (snapshot.emotionDistribution.fear ?? 0) +
    (snapshot.emotionDistribution.disgust ?? 0)
  ) / total;
}

function humanPressure(
  snapshot: ChannelRiskSnapshot,
  counts: ChannelRiskCounts,
): 0 | 1 | 2 {
  const negativeRatio = computeNegativeRatio(snapshot);
  const severeThreadPressure =
    counts.escalatedThreadCount >= 1 ||
    counts.blockedThreadCount >= 2 ||
    counts.riskyThreadCount >= 2;

  if (
    counts.highSeverityAlertCount >= 1 ||
    counts.highRiskMessageCount >= 1 ||
    counts.flaggedMessageCount >= 5 ||
    counts.humanRiskSignalCount >= 4 ||
    severeThreadPressure ||
    snapshot.highRiskCount >= 3 ||
    negativeRatio > 0.3
  ) {
    return 2;
  }

  if (
    counts.openAlertCount >= 1 ||
    counts.blockedThreadCount >= 1 ||
    counts.riskyThreadCount >= 1 ||
    counts.attentionThreadCount >= 2 ||
    counts.flaggedMessageCount >= 2 ||
    counts.humanRiskSignalCount >= 2 ||
    snapshot.highRiskCount >= 1 ||
    negativeRatio > 0.15
  ) {
    return 1;
  }

  return 0;
}

function operationalPressure(counts: ChannelRiskCounts): 0 | 1 | 2 {
  if (
    counts.criticalAutomationIncident24hCount >= 3 ||
    counts.automationIncident24hCount >= 5 ||
    counts.criticalAutomationIncidentCount >= 3 ||
    counts.automationIncidentCount >= 5
  ) {
    return 2;
  }

  if (
    counts.criticalAutomationIncident24hCount >= 1 ||
    counts.automationIncident24hCount >= 2 ||
    counts.criticalAutomationIncidentCount >= 1 ||
    counts.automationIncidentCount >= 2
  ) {
    return 1;
  }

  return 0;
}

export function deriveChannelSignal(
  snapshot: ChannelRiskSnapshot,
  counts: ChannelRiskCounts,
): ChannelRiskSignal {
  const pressure = Math.max(humanPressure(snapshot, counts), operationalPressure(counts));
  if (pressure >= 2) {
    return "escalating";
  }
  if (pressure >= 1) {
    return "elevated";
  }
  return "stable";
}

export function deriveChannelHealth(signal: ChannelRiskSignal): ChannelRiskHealth {
  switch (signal) {
    case "escalating":
      return "at-risk";
    case "elevated":
      return "attention";
    default:
      return "healthy";
  }
}

export function deriveChannelSignalConfidence(
  snapshot: ChannelRiskSnapshot,
  counts: ChannelRiskCounts,
): number {
  const totalWindowMessages = Math.max(0, counts.totalMessageCount);
  const settledCount = snapshot.totalAnalyzed + counts.skippedMessageCount;
  const settledRatio = totalWindowMessages > 0 ? settledCount / totalWindowMessages : 1;
  const analyzedCoverageRatio =
    totalWindowMessages > 0 ? snapshot.totalAnalyzed / totalWindowMessages : 1;

  if (
    snapshot.totalAnalyzed === 0 &&
    counts.openAlertCount === 0 &&
    counts.automationIncidentCount === 0 &&
    counts.flaggedMessageCount === 0 &&
    counts.attentionThreadCount === 0 &&
    counts.humanRiskSignalCount === 0
  ) {
    return 0.5;
  }

  let base = 0.55;
  if (snapshot.totalAnalyzed >= 50) base = 0.85;
  else if (snapshot.totalAnalyzed >= 25) base = 0.8;
  else if (snapshot.totalAnalyzed >= 10) base = 0.72;
  else if (snapshot.totalAnalyzed >= 5) base = 0.64;

  if (counts.automationIncidentCount > 0) {
    base = Math.max(
      base,
      counts.criticalAutomationIncident24hCount > 0 ? 0.78 : 0.68,
    );
  }

  if (counts.humanRiskSignalCount > 0) {
    base = Math.max(base, 0.66);
  }

  const total = Object.values(snapshot.emotionDistribution).reduce(
    (sum, count) => sum + count,
    0,
  ) || 1;
  const dominantShare = Math.max(...Object.values(snapshot.emotionDistribution), 0) / total;
  if (dominantShare > 0.45) {
    base += Math.min(0.06, (dominantShare - 0.45) * 0.15);
  }

  if (counts.flaggedMessageCount > 0 || counts.openAlertCount > 0) {
    base = Math.min(base, 0.82);
  }
  if (counts.highSeverityAlertCount > 0 || counts.highRiskMessageCount > 0) {
    base = Math.min(base, 0.76);
  }
  if (counts.criticalAutomationIncident24hCount > 0) {
    base = Math.min(base, 0.8);
  } else if (counts.automationIncident24hCount > 0 || counts.automationIncidentCount > 0) {
    base = Math.min(base, 0.78);
  }
  if (counts.escalatedThreadCount > 0 || counts.blockedThreadCount > 0) {
    base = Math.min(base, 0.78);
  }

  const negativeRatio = computeNegativeRatio(snapshot);
  if (
    negativeRatio < 0.1 &&
    (
      counts.openAlertCount > 0 ||
      counts.flaggedMessageCount > 0 ||
      counts.attentionThreadCount > 0 ||
      counts.automationIncidentCount > 0
    )
  ) {
    base = Math.min(base, 0.72);
  }

  if (settledRatio < 0.6) {
    base = Math.min(base, 0.72);
  } else if (settledRatio < 0.8) {
    base = Math.min(base, 0.82);
  }

  if (counts.inflightMessageCount > 0 && totalWindowMessages > 0) {
    const inflightRatio = counts.inflightMessageCount / totalWindowMessages;
    base -= Math.min(0.1, inflightRatio * 0.18);
  }

  if (totalWindowMessages >= 12 && analyzedCoverageRatio < 0.25 && counts.automationIncidentCount === 0) {
    base = Math.min(base, 0.76);
  }

  return Math.max(0.35, Math.min(0.93, base));
}

function buildMessageDispositionCounts(
  snapshot: ChannelRiskSnapshot,
  counts: ChannelRiskCounts,
): MessageDispositionCounts {
  const maxStoredWithoutDeepAnalysis = Math.max(
    0,
    counts.totalMessageCount - snapshot.totalAnalyzed - counts.inflightMessageCount,
  );
  const routineAcknowledgments = Math.max(
    0,
    Math.min(counts.ignoredMessageCount, maxStoredWithoutDeepAnalysis),
  );
  const heuristicIncidentSignals = Math.max(
    0,
    Math.min(
      counts.automationIncidentCount,
      Math.max(0, maxStoredWithoutDeepAnalysis - routineAcknowledgments),
    ),
  );
  const contextOnly = Math.max(
    0,
    maxStoredWithoutDeepAnalysis -
      routineAcknowledgments -
      heuristicIncidentSignals,
  );
  const storedWithoutDeepAnalysis =
    contextOnly + routineAcknowledgments + heuristicIncidentSignals;

  return {
    totalInWindow: counts.totalMessageCount,
    deepAiAnalyzed: snapshot.totalAnalyzed,
    heuristicIncidentSignals,
    contextOnly,
    routineAcknowledgments,
    storedWithoutDeepAnalysis,
    inFlight: counts.inflightMessageCount,
  };
}

function buildRiskDrivers(
  snapshot: ChannelRiskSnapshot,
  counts: ChannelRiskCounts,
): RiskDriver[] {
  const drivers: RiskDriver[] = [];
  const negativeRatio = computeNegativeRatio(snapshot);

  if (counts.highSeverityAlertCount > 0) {
    drivers.push({
      key: "high_severity_alerts",
      label: "Open high-severity alerts",
      message: `${counts.highSeverityAlertCount} high-severity alert${counts.highSeverityAlertCount > 1 ? "s remain" : " remains"} unresolved.`,
      severity: "high",
      category: "alert",
    });
  }

  if (counts.criticalAutomationIncident24hCount > 0 || counts.criticalAutomationIncidentCount > 0) {
    drivers.push({
      key: "critical_operational_incidents",
      label: "Critical operational incidents",
      message: `${Math.max(counts.criticalAutomationIncident24hCount, counts.criticalAutomationIncidentCount)} critical automation incident${Math.max(counts.criticalAutomationIncident24hCount, counts.criticalAutomationIncidentCount) > 1 ? "s were" : " was"} detected recently.`,
      severity:
        counts.criticalAutomationIncident24hCount >= 3 ||
        counts.criticalAutomationIncidentCount >= 3
          ? "high"
          : "medium",
      category: "operational",
    });
  } else if (counts.automationIncidentCount > 0) {
    drivers.push({
      key: "operational_incidents",
      label: "Recent automation incidents",
      message: `${counts.automationIncidentCount} operational incident${counts.automationIncidentCount > 1 ? "s were" : " was"} detected in the current window.`,
      severity: counts.automationIncidentCount >= 5 ? "high" : "medium",
      category: "operational",
    });
  }

  if (counts.escalatedThreadCount > 0) {
    drivers.push({
      key: "escalated_threads",
      label: "Escalated surfaced threads",
      message: `${counts.escalatedThreadCount} surfaced thread${counts.escalatedThreadCount > 1 ? "s are" : " is"} escalated.`,
      severity: "high",
      category: "thread",
    });
  } else if (counts.blockedThreadCount > 0) {
    drivers.push({
      key: "blocked_threads",
      label: "Blocked surfaced threads",
      message: `${counts.blockedThreadCount} surfaced thread${counts.blockedThreadCount > 1 ? "s are" : " is"} blocked or waiting on resolution.`,
      severity: "medium",
      category: "thread",
    });
  } else if (counts.riskyThreadCount > 0) {
    drivers.push({
      key: "risky_threads",
      label: "Risky surfaced threads",
      message: `${counts.riskyThreadCount} surfaced thread${counts.riskyThreadCount > 1 ? "s carry" : " carries"} medium or high operational risk.`,
      severity: "medium",
      category: "thread",
    });
  }

  if (counts.highRiskMessageCount > 0) {
    drivers.push({
      key: "high_risk_sentiment",
      label: "Recent high-risk sentiment",
      message: `${counts.highRiskMessageCount} recent message${counts.highRiskMessageCount > 1 ? "s were" : " was"} marked high escalation risk.`,
      severity: "high",
      category: "human",
    });
  } else if (counts.flaggedMessageCount > 0) {
    drivers.push({
      key: "flagged_sentiment",
      label: "Flagged sentiment messages",
      message: `${counts.flaggedMessageCount} recent message${counts.flaggedMessageCount > 1 ? "s were" : " was"} flagged medium or high risk.`,
      severity: counts.flaggedMessageCount >= 5 ? "high" : "medium",
      category: "human",
    });
  } else if (counts.humanRiskSignalCount > 0) {
    drivers.push({
      key: "human_risk_signals",
      label: "Human risk signals",
      message: `${counts.humanRiskSignalCount} recent conversation signal${counts.humanRiskSignalCount > 1 ? "s suggest" : " suggests"} blocker, escalation, or meaningful tension.`,
      severity: counts.humanRiskSignalCount >= 4 ? "high" : "medium",
      category: "human",
    });
  }

  if (negativeRatio > 0.15) {
    drivers.push({
      key: "negative_tone",
      label: negativeRatio > 0.3 ? "Strongly negative tone" : "Negative tone trend",
      message: `${Math.round(negativeRatio * 100)}% of recent analyzed messages skew negative.`,
      severity: negativeRatio > 0.3 ? "high" : "medium",
      category: "human",
    });
  }

  return drivers;
}

function buildAttentionSummary(
  signal: ChannelRiskSignal,
  counts: ChannelRiskCounts,
  drivers: RiskDriver[],
): AttentionSummary {
  if (drivers.length === 0) {
    return {
      status: "clear",
      title: "Nothing needs attention",
      message: "Nothing needs attention in this channel right now.",
      driverKeys: [],
    };
  }

  const topDriver = drivers[0];
  const actionRequired =
    signal === "escalating" ||
    counts.highSeverityAlertCount > 0 ||
    counts.criticalAutomationIncident24hCount > 0 ||
    counts.highRiskMessageCount > 0 ||
    counts.escalatedThreadCount > 0;

  return {
    status: actionRequired ? "action" : "watch",
    title: actionRequired ? "Attention required" : "Worth reviewing",
    message: topDriver.message,
    driverKeys: drivers.map((driver) => driver.key),
  };
}

export function buildChannelRiskState(
  row?: ChannelHealthCountsRow | null,
  options?: {
    effectiveChannelMode?: ChannelMode | null;
  },
): ChannelRiskState {
  const healthCounts: ChannelRiskCounts = {
    analysisWindowDays: Math.max(1, parseCount(row?.analysis_window_days ?? 7)),
    openAlertCount: parseCount(row?.open_alert_count),
    highSeverityAlertCount: parseCount(row?.high_severity_alert_count),
    automationIncidentCount: parseCount(row?.automation_incident_count),
    criticalAutomationIncidentCount: parseCount(row?.critical_automation_incident_count),
    automationIncident24hCount: parseCount(row?.automation_incident_24h_count),
    criticalAutomationIncident24hCount: parseCount(row?.critical_automation_incident_24h_count),
    humanRiskSignalCount: parseCount(row?.human_risk_signal_count),
    requestSignalCount: parseCount(row?.request_signal_count),
    decisionSignalCount: parseCount(row?.decision_signal_count),
    resolutionSignalCount: parseCount(row?.resolution_signal_count),
    flaggedMessageCount: parseCount(row?.flagged_message_count),
    highRiskMessageCount: parseCount(row?.high_risk_message_count),
    attentionThreadCount: parseCount(row?.attention_thread_count),
    blockedThreadCount: parseCount(row?.blocked_thread_count),
    escalatedThreadCount: parseCount(row?.escalated_thread_count),
    riskyThreadCount: parseCount(row?.risky_thread_count),
    totalMessageCount: parseCount(row?.total_message_count),
    skippedMessageCount: parseCount(row?.skipped_message_count),
    contextOnlyMessageCount: parseCount(row?.context_only_message_count),
    ignoredMessageCount: parseCount(row?.ignored_message_count),
    inflightMessageCount: parseCount(row?.inflight_message_count),
  };

  const sentimentSnapshot: ChannelRiskSnapshot = {
    totalAnalyzed: parseCount(row?.total_analyzed_count),
    highRiskCount: healthCounts.highRiskMessageCount,
    emotionDistribution: {
      anger: parseCount(row?.anger_count),
      disgust: parseCount(row?.disgust_count),
      fear: parseCount(row?.fear_count),
      joy: parseCount(row?.joy_count),
      neutral: parseCount(row?.neutral_count),
      sadness: parseCount(row?.sadness_count),
      surprise: parseCount(row?.surprise_count),
    },
  };

  const signal = deriveChannelSignal(sentimentSnapshot, healthCounts);
  const riskDrivers = buildRiskDrivers(sentimentSnapshot, healthCounts);
  return {
    healthCounts,
    sentimentSnapshot,
    signal,
    health: deriveChannelHealth(signal),
    signalConfidence: deriveChannelSignalConfidence(
      sentimentSnapshot,
      healthCounts,
    ),
    negativeRatio: computeNegativeRatio(sentimentSnapshot),
    effectiveChannelMode: options?.effectiveChannelMode ?? "collaboration",
    riskDrivers,
    attentionSummary: buildAttentionSummary(signal, healthCounts, riskDrivers),
    messageDispositionCounts: buildMessageDispositionCounts(
      sentimentSnapshot,
      healthCounts,
    ),
  };
}
