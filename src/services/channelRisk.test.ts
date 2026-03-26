import { describe, expect, it } from "vitest";
import { buildChannelRiskState } from "./channelRisk.js";
import type { ChannelHealthCountsRow } from "../types/database.js";

function buildRow(
  overrides: Partial<ChannelHealthCountsRow> = {},
): ChannelHealthCountsRow {
  return {
    channel_id: "C123ABC",
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

describe("buildChannelRiskState", () => {
  it("marks a calm recent window with no active alerts as stable", () => {
    const result = buildChannelRiskState(buildRow());

    expect(result.signal).toBe("stable");
    expect(result.health).toBe("healthy");
    expect(result.healthCounts.analysisWindowDays).toBe(7);
  });

  it("raises the signal to elevated when open follow-up alerts exist", () => {
    const result = buildChannelRiskState(
      buildRow({ open_alert_count: "1" }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
  });

  it("raises the signal to elevated when a blocked surfaced thread is active", () => {
    const result = buildChannelRiskState(
      buildRow({
        attention_thread_count: "1",
        blocked_thread_count: "1",
        risky_thread_count: "1",
      }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
  });

  it("raises the signal to elevated for recent automated workflow failures", () => {
    const result = buildChannelRiskState(
      buildRow({
        automation_incident_count: "2",
        critical_automation_incident_count: "1",
        automation_incident_24h_count: "2",
        critical_automation_incident_24h_count: "1",
        total_analyzed_count: "0",
        anger_count: "0",
        joy_count: "0",
        sadness_count: "0",
        neutral_count: "0",
        fear_count: "0",
        surprise_count: "0",
        disgust_count: "0",
      }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
    expect(result.signalConfidence).toBeGreaterThan(0.5);
  });

  it("raises the signal to escalating for sustained automation incident pressure", () => {
    const result = buildChannelRiskState(
      buildRow({
        automation_incident_count: "8",
        critical_automation_incident_count: "6",
        automation_incident_24h_count: "5",
        critical_automation_incident_24h_count: "3",
        total_analyzed_count: "0",
        joy_count: "0",
        neutral_count: "0",
      }),
    );

    expect(result.signal).toBe("escalating");
    expect(result.health).toBe("at-risk");
    expect(result.signalConfidence).toBeLessThanOrEqual(0.78);
  });

  it("keeps a single flagged medium-risk message in watch mode rather than elevating the whole channel", () => {
    const result = buildChannelRiskState(
      buildRow({ flagged_message_count: "1" }),
    );

    expect(result.signal).toBe("stable");
    expect(result.health).toBe("healthy");
  });

  it("keeps collaboration channels at elevated for uncorroborated high-severity alert pressure", () => {
    const result = buildChannelRiskState(
      buildRow({ high_severity_alert_count: "1" }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
  });

  it("raises collaboration channels to escalating when high-severity alerts are corroborated by blocked thread pressure", () => {
    const result = buildChannelRiskState(
      buildRow({
        high_severity_alert_count: "1",
        blocked_thread_count: "1",
      }),
    );

    expect(result.signal).toBe("escalating");
    expect(result.health).toBe("at-risk");
  });

  it("keeps collaboration channels at elevated when alerts are paired only with light heuristic risk", () => {
    const result = buildChannelRiskState(
      buildRow({
        high_severity_alert_count: "2",
        human_risk_signal_count: "2",
        risky_thread_count: "1",
      }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
  });

  it("lets strong decision and resolution momentum settle light collaboration risk back to stable", () => {
    const result = buildChannelRiskState(
      buildRow({
        human_risk_signal_count: "2",
        risky_thread_count: "1",
        decision_signal_count: "3",
        resolution_signal_count: "2",
      }),
    );

    expect(result.signal).toBe("stable");
    expect(result.health).toBe("healthy");
  });

  it("downgrades collaboration-channel heuristic escalation when there is strong stabilizing momentum", () => {
    const result = buildChannelRiskState(
      buildRow({
        human_risk_signal_count: "5",
        flagged_message_count: "8",
        decision_signal_count: "3",
        resolution_signal_count: "2",
      }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.health).toBe("attention");
  });

  it("does not let stabilizing momentum override hard-risk evidence", () => {
    const result = buildChannelRiskState(
      buildRow({
        high_risk_message_count: "2",
        flagged_message_count: "8",
        decision_signal_count: "4",
        resolution_signal_count: "3",
      }),
    );

    expect(result.signal).toBe("escalating");
    expect(result.health).toBe("at-risk");
  });

  it("keeps mixed-mode channels on strict high-severity alert escalation", () => {
    const result = buildChannelRiskState(
      buildRow({ high_severity_alert_count: "1" }),
      { effectiveChannelMode: "mixed" },
    );

    expect(result.signal).toBe("escalating");
    expect(result.health).toBe("at-risk");
  });

  it("raises the signal to escalating when recent flagged volume is corroborated", () => {
    const result = buildChannelRiskState(
      buildRow({ flagged_message_count: "8", human_risk_signal_count: "5" }),
    );

    expect(result.signal).toBe("escalating");
  });

  it("caps confidence when calm tone conflicts with live alerts", () => {
    const result = buildChannelRiskState(
      buildRow({
        open_alert_count: "1",
        total_analyzed_count: "100",
        anger_count: "0",
        sadness_count: "0",
        fear_count: "0",
        disgust_count: "0",
        joy_count: "70",
        neutral_count: "30",
      }),
    );

    expect(result.signal).toBe("elevated");
    expect(result.signalConfidence).toBeLessThanOrEqual(0.72);
  });

  it("caps confidence when only a small share of the rolling window was deeply analyzed", () => {
    const result = buildChannelRiskState(
      buildRow({
        total_message_count: "60",
        total_analyzed_count: "10",
        skipped_message_count: "18",
        inflight_message_count: "2",
        joy_count: "6",
        neutral_count: "4",
      }),
    );

    expect(result.signalConfidence).toBeLessThanOrEqual(0.82);
  });

  it("does not infer negative tone when analyzed coverage is zero", () => {
    const result = buildChannelRiskState(
      buildRow({
        total_analyzed_count: "0",
        anger_count: "3",
        sadness_count: "2",
        joy_count: "0",
        neutral_count: "0",
        human_risk_signal_count: "0",
        risky_thread_count: "0",
      }),
    );

    expect(result.negativeRatio).toBe(0);
    expect(result.riskDrivers.some((driver) => driver.key === "negative_tone")).toBe(false);
  });

  it("reduces confidence when stabilizing evidence conflicts with light heuristic risk", () => {
    const result = buildChannelRiskState(
      buildRow({
        total_analyzed_count: "0",
        joy_count: "0",
        neutral_count: "0",
        human_risk_signal_count: "2",
        risky_thread_count: "1",
        decision_signal_count: "3",
        resolution_signal_count: "2",
      }),
    );

    expect(result.signalConfidence).toBeLessThanOrEqual(0.58);
  });

  it("keeps stored-without-deep-analysis bounded to the live window invariant", () => {
    const result = buildChannelRiskState(
      buildRow({
        total_message_count: "94",
        skipped_message_count: "95",
        context_only_message_count: "84",
        ignored_message_count: "7",
        automation_incident_count: "1",
        total_analyzed_count: "0",
        joy_count: "0",
        neutral_count: "0",
      }),
    );

    expect(result.messageDispositionCounts.storedWithoutDeepAnalysis).toBe(94);
    expect(
      result.messageDispositionCounts.contextOnly +
        result.messageDispositionCounts.routineAcknowledgments +
        result.messageDispositionCounts.heuristicIncidentSignals,
    ).toBe(result.messageDispositionCounts.storedWithoutDeepAnalysis);
  });
});
