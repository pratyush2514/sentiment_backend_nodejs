import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelStateRow } from "../types/database.js";

vi.mock("../config.js", () => ({
  config: {
    LLM_RISK_THRESHOLD: 0.7,
    LLM_MSG_THRESHOLD: 20,
    LLM_TIME_THRESHOLD_MIN: 10,
    LLM_COOLDOWN_SEC: 60,
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { evaluateLLMGate } = await import("./llmGate.js");

function makeChannelState(overrides: Partial<ChannelStateRow> = {}): ChannelStateRow {
  const base: ChannelStateRow = {
    id: "test-id",
    workspace_id: "W123",
    channel_id: "C123",
    running_summary: "",
    live_summary: "",
    live_summary_updated_at: null,
    live_summary_source_ts_start: null,
    live_summary_source_ts_end: null,
    participants_json: {},
    active_threads_json: [],
    key_decisions_json: [],
    signal: "stable",
    health: "healthy",
    signal_confidence: 0.5,
    risk_drivers_json: [],
    attention_summary_json: {
      status: "clear",
      title: "No active attention",
      message: "Nothing needs attention right now.",
      driverKeys: [],
    },
    message_disposition_counts_json: {
      totalInWindow: 0,
      deepAiAnalyzed: 0,
      heuristicIncidentSignals: 0,
      contextOnly: 0,
      routineAcknowledgments: 0,
      storedWithoutDeepAnalysis: 0,
      inFlight: 0,
    },
    effective_channel_mode: "collaboration",
    sentiment_snapshot_json: { totalMessages: 0, highRiskCount: 0, updatedAt: "" },
    messages_since_last_llm: 0,
    last_llm_run_at: null,
    llm_cooldown_until: null,
    last_reconcile_at: null,
    messages_since_last_rollup: 0,
    last_rollup_at: null,
    updated_at: new Date(),
  };

  return {
    ...base,
    ...overrides,
    signal: overrides.signal ?? base.signal,
    health: overrides.health ?? base.health,
    signal_confidence: overrides.signal_confidence ?? base.signal_confidence,
    risk_drivers_json: overrides.risk_drivers_json ?? base.risk_drivers_json,
    attention_summary_json: overrides.attention_summary_json ?? base.attention_summary_json,
    message_disposition_counts_json:
      overrides.message_disposition_counts_json ?? base.message_disposition_counts_json,
    effective_channel_mode: overrides.effective_channel_mode ?? base.effective_channel_mode,
  };
}

describe("evaluateLLMGate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for neutral text with low message count", () => {
    const state = makeChannelState({ messages_since_last_llm: 5 });
    expect(evaluateLLMGate("sounds good, thanks", state)).toBeNull();
  });

  it("triggers 'risk' for high risk score text", () => {
    const state = makeChannelState({ messages_since_last_llm: 2 });
    // "furious" + "terrible" + "unacceptable" = 3 * 0.3 = 0.9 >= 0.7
    const result = evaluateLLMGate("I am furious, this is terrible and unacceptable", state);
    expect(result).toBe("risk");
  });

  it("triggers 'threshold' when message count reaches threshold", () => {
    const state = makeChannelState({ messages_since_last_llm: 20 });
    expect(evaluateLLMGate("normal message", state)).toBe("threshold");
  });

  it("triggers 'time' when enough time has elapsed with pending messages", () => {
    const tenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
    const state = makeChannelState({
      messages_since_last_llm: 3,
      last_llm_run_at: tenMinAgo,
    });
    expect(evaluateLLMGate("normal message", state)).toBe("time");
  });

  it("does not trigger 'time' when no messages since last LLM", () => {
    const tenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
    const state = makeChannelState({
      messages_since_last_llm: 0,
      last_llm_run_at: tenMinAgo,
    });
    expect(evaluateLLMGate("normal message", state)).toBeNull();
  });

  it("does not trigger when in cooldown (channel message)", () => {
    const futureTime = new Date(Date.now() + 30_000); // 30s from now
    const state = makeChannelState({
      messages_since_last_llm: 25,
      llm_cooldown_until: futureTime,
    });
    // No threadTs = channel message, cooldown blocks it
    expect(evaluateLLMGate("I am furious", state)).toBeNull();
  });

  it("triggers after cooldown expires", () => {
    const pastTime = new Date(Date.now() - 1000); // 1s ago
    const state = makeChannelState({
      messages_since_last_llm: 25,
      llm_cooldown_until: pastTime,
    });
    expect(evaluateLLMGate("normal message", state)).toBe("threshold");
  });

  it("prioritizes risk trigger over threshold", () => {
    const state = makeChannelState({ messages_since_last_llm: 25 });
    // Both risk (0.9) and threshold (25 >= 20) qualify; risk checked first
    const result = evaluateLLMGate("I am furious, this is terrible and unacceptable", state);
    expect(result).toBe("risk");
  });

  it("does not trigger 'time' when last_llm_run_at is null", () => {
    const state = makeChannelState({
      messages_since_last_llm: 3,
      last_llm_run_at: null,
    });
    expect(evaluateLLMGate("normal message", state)).toBeNull();
  });

  it("thread reply still triggers risk even when the channel is in cooldown", () => {
    const futureTime = new Date(Date.now() + 30_000);
    const state = makeChannelState({
      messages_since_last_llm: 2,
      llm_cooldown_until: futureTime,
    });
    const result = evaluateLLMGate("I am furious, this is terrible and unacceptable", state, "1234567890.123456");
    expect(result).toBe("risk");
  });

  it("thread reply does not trigger threshold-based analysis", () => {
    const futureTime = new Date(Date.now() + 30_000);
    const state = makeChannelState({
      messages_since_last_llm: 25,
      llm_cooldown_until: futureTime,
    });
    const result = evaluateLLMGate("normal message", state, "1234567890.123456");
    expect(result).toBeNull();
  });
});
