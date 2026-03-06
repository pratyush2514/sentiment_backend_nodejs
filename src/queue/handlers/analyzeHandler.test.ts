import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getMessages: vi.fn().mockResolvedValue([]),
  getChannelState: vi.fn().mockResolvedValue(null),
  updateMessageAnalysisStatus: vi.fn(),
  insertMessageAnalytics: vi.fn(),
  insertLLMCost: vi.fn(),
  upsertChannelState: vi.fn(),
}));

vi.mock("../../services/emotionAnalyzer.js", () => ({
  analyzeMessage: vi.fn(),
  analyzeThread: vi.fn(),
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

const db = await import("../../db/queries.js");
const { analyzeMessage } = await import("../../services/emotionAnalyzer.js");
const { alertBudgetExceeded } = await import("../../services/alerting.js");
const { handleLLMAnalyze } = await import("./analyzeHandler.js");

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
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage("1.1", { analysis_status: "completed" }),
    ] as never);

    await handleLLMAnalyze([makeJob()] as never);
    expect(db.insertMessageAnalytics).not.toHaveBeenCalled();
  });

  it("stores analytics for successful channel analysis", async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage("1.1"),
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      id: "cs-1", workspace_id: "default", channel_id: "C123",
      running_summary: "", participants_json: {}, active_threads_json: [],
      key_decisions_json: [], sentiment_snapshot_json: { totalMessages: 0, highRiskCount: 0, updatedAt: "" },
      messages_since_last_llm: 5, last_llm_run_at: null,
      llm_cooldown_until: null, last_reconcile_at: null,
      messages_since_last_rollup: 0, last_rollup_at: null,
      updated_at: new Date(),
    });
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
      "default", "C123", "1.1", "completed",
    );
  });

  it("marks messages failed on LLM error", async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      makeMessage("1.1"),
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
      "default", "C123", "1.1", "failed",
    );
  });
});
