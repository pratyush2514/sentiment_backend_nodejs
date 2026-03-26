import type { ChannelRiskHealth, ChannelRiskSignal } from "../services/channelRisk.js";
import type { ChannelHealthCountsRow, ChannelMode } from "../types/database.js";

export interface ChannelRiskEvalFixture {
  id: string;
  description: string;
  effectiveChannelMode?: ChannelMode;
  row: Partial<ChannelHealthCountsRow>;
  expected: {
    signal: ChannelRiskSignal;
    health: ChannelRiskHealth;
    minConfidence?: number;
    maxConfidence?: number;
  };
}

export function buildChannelHealthRow(
  overrides: Partial<ChannelHealthCountsRow> = {},
): ChannelHealthCountsRow {
  return {
    channel_id: "CEVAL123",
    analysis_window_days: 7,
    open_alert_count: "0",
    high_severity_alert_count: "0",
    automation_incident_count: "0",
    critical_automation_incident_count: "0",
    automation_incident_24h_count: "0",
    critical_automation_incident_24h_count: "0",
    human_risk_signal_count: "0",
    request_signal_count: "0",
    decision_signal_count: "0",
    resolution_signal_count: "0",
    flagged_message_count: "0",
    high_risk_message_count: "0",
    attention_thread_count: "0",
    blocked_thread_count: "0",
    escalated_thread_count: "0",
    risky_thread_count: "0",
    total_message_count: "20",
    skipped_message_count: "0",
    context_only_message_count: "0",
    ignored_message_count: "0",
    inflight_message_count: "0",
    total_analyzed_count: "20",
    anger_count: "1",
    joy_count: "10",
    sadness_count: "1",
    neutral_count: "8",
    fear_count: "0",
    surprise_count: "0",
    disgust_count: "0",
    ...overrides,
  };
}

export const channelRiskEvalFixtures: ChannelRiskEvalFixture[] = [
  {
    id: "collaboration-normal-problem-solving",
    description: "Normal engineering blocker discussion with strong decision and resolution momentum should not turn red.",
    effectiveChannelMode: "collaboration",
    row: {
      total_analyzed_count: "0",
      joy_count: "0",
      neutral_count: "0",
      human_risk_signal_count: "2",
      risky_thread_count: "1",
      decision_signal_count: "3",
      resolution_signal_count: "2",
    },
    expected: {
      signal: "stable",
      health: "healthy",
      maxConfidence: 0.58,
    },
  },
  {
    id: "collaboration-uncorroborated-alert",
    description: "A lone severe follow-up alert in a collaboration channel should stay attention-level.",
    effectiveChannelMode: "collaboration",
    row: {
      high_severity_alert_count: "1",
    },
    expected: {
      signal: "elevated",
      health: "attention",
      maxConfidence: 0.76,
    },
  },
  {
    id: "collaboration-alert-plus-blocked-thread",
    description: "When alert pressure is corroborated by a blocked thread, collaboration channels should escalate.",
    effectiveChannelMode: "collaboration",
    row: {
      high_severity_alert_count: "1",
      blocked_thread_count: "1",
    },
    expected: {
      signal: "escalating",
      health: "at-risk",
      maxConfidence: 0.78,
    },
  },
  {
    id: "mixed-mode-severe-alert",
    description: "Mixed or operational channels should keep strict severe-alert handling.",
    effectiveChannelMode: "mixed",
    row: {
      high_severity_alert_count: "1",
    },
    expected: {
      signal: "escalating",
      health: "at-risk",
      maxConfidence: 0.76,
    },
  },
  {
    id: "automation-pressure",
    description: "Sustained automation incidents should escalate even without analyzed sentiment.",
    effectiveChannelMode: "automation",
    row: {
      automation_incident_count: "8",
      critical_automation_incident_count: "6",
      automation_incident_24h_count: "5",
      critical_automation_incident_24h_count: "3",
      total_analyzed_count: "0",
      joy_count: "0",
      neutral_count: "0",
    },
    expected: {
      signal: "escalating",
      health: "at-risk",
      minConfidence: 0.68,
      maxConfidence: 0.78,
    },
  },
  {
    id: "single-flagged-message",
    description: "One medium-risk message should not elevate a whole channel by itself.",
    effectiveChannelMode: "collaboration",
    row: {
      flagged_message_count: "1",
    },
    expected: {
      signal: "stable",
      health: "healthy",
    },
  },
  {
    id: "hard-risk-overrides-stabilizers",
    description: "Resolution momentum must not suppress strong analyzed risk evidence.",
    effectiveChannelMode: "collaboration",
    row: {
      high_risk_message_count: "1",
      decision_signal_count: "4",
      resolution_signal_count: "3",
    },
    expected: {
      signal: "escalating",
      health: "at-risk",
      maxConfidence: 0.76,
    },
  },
];
