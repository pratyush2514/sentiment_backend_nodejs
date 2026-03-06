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
  return {
    id: "test-id",
    workspace_id: "W123",
    channel_id: "C123",
    running_summary: "",
    participants_json: {},
    active_threads_json: [],
    key_decisions_json: [],
    sentiment_snapshot_json: { totalMessages: 0, highRiskCount: 0, updatedAt: "" },
    messages_since_last_llm: 0,
    last_llm_run_at: null,
    llm_cooldown_until: null,
    last_reconcile_at: null,
    messages_since_last_rollup: 0,
    last_rollup_at: null,
    updated_at: new Date(),
    ...overrides,
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

  it("thread reply bypasses cooldown and triggers risk", () => {
    const futureTime = new Date(Date.now() + 30_000); // channel is in cooldown
    const state = makeChannelState({
      messages_since_last_llm: 2,
      llm_cooldown_until: futureTime,
    });
    // "furious" + "terrible" + "unacceptable" = 0.9 >= 0.7
    // Channel cooldown would block this, but threadTs bypasses it
    const result = evaluateLLMGate("I am furious, this is terrible and unacceptable", state, "1234567890.123456");
    expect(result).toBe("risk");
  });

  it("thread reply bypasses cooldown and triggers threshold", () => {
    const futureTime = new Date(Date.now() + 30_000); // channel is in cooldown
    const state = makeChannelState({
      messages_since_last_llm: 25,
      llm_cooldown_until: futureTime,
    });
    // Channel cooldown would block this, but threadTs bypasses it
    const result = evaluateLLMGate("normal message", state, "1234567890.123456");
    expect(result).toBe("threshold");
  });
});
