import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelStateRow } from "../../types/database.js";

vi.mock("../../config.js", () => ({
  config: {
    LLM_PROVIDER: "openai",
    LLM_DAILY_BUDGET_USD: 10.0,
    NODE_ENV: "test",
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../../db/queries.js", () => ({
  getDailyLLMCost: vi.fn().mockResolvedValue(0),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessagesByTs: vi.fn().mockResolvedValue([]),
  getMessagesEnrichedByTs: vi.fn().mockResolvedValue([]),
  getChannelState: vi.fn().mockResolvedValue(null),
  updateMessageAnalysisStatus: vi.fn(),
  insertMessageAnalytics: vi.fn(),
  insertLLMCost: vi.fn(),
  upsertChannelState: vi.fn(),
}));

vi.mock("../../services/emotionAnalyzer.js", () => ({
  analyzeMessage: vi.fn(),
}));

vi.mock("../../services/alerting.js", () => ({
  checkAndAlert: vi.fn(),
  alertBudgetExceeded: vi.fn(),
}));

vi.mock("../../services/riskHeuristic.js", () => ({
  computeRiskScore: vi.fn().mockReturnValue(0.1),
}));

vi.mock("../../services/costEstimator.js", () => ({
  estimateCost: vi.fn().mockReturnValue(0.001),
}));

vi.mock("../../services/contextAssembler.js", () => ({
  assembleContext: vi.fn().mockResolvedValue({
    runningSummary: "test summary",
    keyDecisions: [],
    relevantDocuments: [],
    recentMessages: [],
    totalTokens: 100,
  }),
}));

vi.mock("../../services/canonicalChannelState.js", () => ({
  persistCanonicalChannelState: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("../../db/queries.js");
const { analyzeMessage } = await import("../../services/emotionAnalyzer.js");
const { alertBudgetExceeded } = await import("../../services/alerting.js");
const { handleLLMAnalyze } = await import("./analyzeHandler.js");

function makeChannelState(
  overrides: Partial<ChannelStateRow> = {},
): ChannelStateRow {
  return {
    id: "cs-1",
    workspace_id: "default",
    channel_id: "C123",
    running_summary: "",
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
    ...overrides,
  };
}

function recentTs(offsetSeconds = 0): string {
  return String(Date.now() / 1000 - offsetSeconds);
}

function makeJob(overrides = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      channelId: "C123",
      triggerType: "threshold",
      threadTs: null,
      ...overrides,
    },
  };
}

function makeMessage(ts: string, overrides = {}) {
  return {
    id: "m-1", workspace_id: "default", channel_id: "C123",
    ts, thread_ts: null, user_id: "U1", text: "test",
    normalized_text: "test", subtype: null, bot_id: null,
    source: "realtime", analysis_status: "pending",
    created_at: new Date(), updated_at: new Date(),
    ma_dominant_emotion: null,
    ma_interaction_tone: null,
    ma_confidence: null,
    ma_escalation_risk: null,
    ma_explanation: null,
    ma_themes: [],
    ma_raw_llm_response: null,
    display_name: "Alice",
    real_name: "Alice",
    mt_candidate_kind: "message_candidate",
    mt_surface_priority: "medium",
    mt_reason_codes: [],
    mt_state_transition: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getDailyLLMCost).mockResolvedValue(0);
});

describe("handleLLMAnalyze", () => {
  it("skips when budget exceeded", async () => {
    vi.mocked(db.getDailyLLMCost).mockResolvedValue(15.0);
    await handleLLMAnalyze([makeJob()] as never);

    expect(alertBudgetExceeded).toHaveBeenCalled();
    expect(db.insertMessageAnalytics).not.toHaveBeenCalled();
  });

  it("skips when no messages found", async () => {
    vi.mocked(db.getMessages).mockResolvedValue([]);
    await handleLLMAnalyze([makeJob()] as never);

    expect(db.insertMessageAnalytics).not.toHaveBeenCalled();
  });

  it("skips when latest message already analyzed", async () => {
    const ts = recentTs(10);
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage(ts, { analysis_status: "completed" }),
    ] as never);
    vi.mocked(db.getMessagesEnrichedByTs).mockResolvedValue([
      makeMessage(ts, {
        analysis_status: "completed",
        ma_dominant_emotion: "joy",
        ma_confidence: 0.8,
        ma_escalation_risk: "low",
        ma_explanation: "Already analyzed",
      }),
    ] as never);

    await handleLLMAnalyze([makeJob()] as never);
    expect(db.insertMessageAnalytics).not.toHaveBeenCalled();
  });

  it("stores analytics for successful channel analysis", async () => {
    const ts = recentTs(10);
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage(ts),
    ] as never);
    vi.mocked(db.getMessagesEnrichedByTs).mockResolvedValue([
      makeMessage(ts),
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue(
      makeChannelState({ messages_since_last_llm: 5 }),
    );
    vi.mocked(analyzeMessage).mockResolvedValue({
      status: "success",
      data: {
        dominant_emotion: "joy",
        confidence: 0.9,
        escalation_risk: "low",
        sarcasm_detected: false,
        explanation: "Positive message",
      },
      raw: { model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    } as never);

    await handleLLMAnalyze([makeJob()] as never);

    expect(db.insertMessageAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        dominantEmotion: "joy",
        confidence: 0.9,
        escalationRisk: "low",
      }),
    );
    expect(db.insertLLMCost).toHaveBeenCalled();
    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default", "C123", expect.any(String), "completed",
    );
  });

  it("marks messages failed on LLM error", async () => {
    const ts = recentTs(10);
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage(ts),
    ] as never);
    vi.mocked(db.getMessagesEnrichedByTs).mockResolvedValue([
      makeMessage(ts),
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue(null);
    vi.mocked(analyzeMessage).mockResolvedValue({
      status: "failed",
      error: "LLM error",
      data: null,
      raw: { model: "gpt-4o-mini", promptTokens: 100, completionTokens: 0 },
    } as never);

    await handleLLMAnalyze([makeJob()] as never);

    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default", "C123", expect.any(String), "failed",
    );
  });

  it("only marks explicit targets completed when analyzing a visible batch", async () => {
    const oldestTs = recentTs(30);
    const middleTs = recentTs(20);
    const newestTs = recentTs(10);
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage(oldestTs),
      makeMessage(middleTs),
      makeMessage(newestTs),
    ] as never);
    vi.mocked(db.getMessagesEnrichedByTs).mockResolvedValue([
      makeMessage(middleTs),
      makeMessage(newestTs),
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue(null);
    vi.mocked(analyzeMessage).mockResolvedValue({
      status: "success",
      data: {
        dominant_emotion: "neutral",
        confidence: 0.72,
        escalation_risk: "low",
        sarcasm_detected: false,
        explanation: "Resolved analysis.",
      },
      raw: { model: "gpt-4o-mini", promptTokens: 80, completionTokens: 30 },
    } as never);

    await handleLLMAnalyze([makeJob({
      mode: "visible_messages",
      targetMessageTs: [middleTs, newestTs],
    })] as never);

    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default",
      "C123",
      middleTs,
      "completed",
    );
    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default",
      "C123",
      newestTs,
      "completed",
    );
    expect(db.updateMessageAnalysisStatus).not.toHaveBeenCalledWith(
      "default",
      "C123",
      oldestTs,
      "completed",
    );
    expect(db.insertMessageAnalytics).toHaveBeenCalledTimes(2);
  });

  it("skips explicit manual targets that are outside the configured analysis window", async () => {
    await handleLLMAnalyze([makeJob({
      mode: "visible_messages",
      targetMessageTs: ["1.2", "1.3"],
    })] as never);

    expect(db.getMessages).not.toHaveBeenCalled();
    expect(db.insertMessageAnalytics).not.toHaveBeenCalled();
  });

  it("continues processing later jobs when an earlier job is skipped", async () => {
    const ts = recentTs(10);
    vi.mocked(db.getDailyLLMCost)
      .mockResolvedValueOnce(15.0)
      .mockResolvedValueOnce(0);
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage(ts, {
        channel_id: "C456",
      }),
    ] as never);
    vi.mocked(db.getMessagesEnrichedByTs).mockResolvedValue([
      makeMessage(ts, {
        channel_id: "C456",
      }),
    ] as never);
    vi.mocked(analyzeMessage).mockResolvedValue({
      status: "success",
      data: {
        dominant_emotion: "neutral",
        confidence: 0.88,
        escalation_risk: "low",
        sarcasm_detected: false,
        explanation: "Handled normally",
      },
      raw: { model: "gpt-4o-mini", promptTokens: 90, completionTokens: 40 },
    } as never);

    await handleLLMAnalyze([
      makeJob({ channelId: "C123" }),
      makeJob({ channelId: "C456" }),
    ] as never);

    expect(alertBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(db.insertMessageAnalytics).toHaveBeenCalledTimes(1);
    expect(db.insertMessageAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C456",
      }),
    );
  });
});
