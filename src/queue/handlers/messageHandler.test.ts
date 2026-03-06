import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    ROLLUP_MSG_THRESHOLD: 20,
    ROLLUP_TIME_THRESHOLD_MIN: 10,
    ROLLUP_THREAD_REPLY_THRESHOLD: 10,
    LLM_COOLDOWN_SEC: 60,
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
  upsertMessage: vi.fn(),
  upsertThreadEdge: vi.fn(),
  updateChannelLastEvent: vi.fn(),
  incrementMessagesSinceLLM: vi.fn(),
  incrementMessagesSinceRollup: vi.fn(),
  updateNormalizedText: vi.fn(),
  getChannelState: vi.fn(),
  resetLLMGatingState: vi.fn(),
  getThreadReplyCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../services/userProfiles.js", () => ({
  resolveUserProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/textNormalizer.js", () => ({
  normalizeText: vi.fn((text: string) => text),
}));

vi.mock("../../services/llmGate.js", () => ({
  evaluateLLMGate: vi.fn().mockReturnValue(null),
}));

vi.mock("../boss.js", () => ({
  enqueueLLMAnalyze: vi.fn().mockResolvedValue("job-llm-1"),
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-1"),
}));

const db = await import("../../db/queries.js");
const boss = await import("../boss.js");
const { evaluateLLMGate } = await import("../../services/llmGate.js");
const { handleMessageIngest } = await import("./messageHandler.js");

function makeJob(overrides = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      channelId: "C123",
      ts: "1.1",
      userId: "U1",
      text: "hello world",
      threadTs: null,
      eventId: "ev-1",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannelState).mockResolvedValue({
    id: "cs-1",
    workspace_id: "default",
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
  });
  vi.mocked(evaluateLLMGate).mockReturnValue(null);
  vi.mocked(db.getThreadReplyCount).mockResolvedValue(0);
});

describe("handleMessageIngest", () => {
  it("stores message and increments both counters", async () => {
    await handleMessageIngest([makeJob()] as never);

    expect(db.upsertMessage).toHaveBeenCalledWith(
      "default", "C123", "1.1", "U1", "hello world", "realtime", null,
    );
    expect(db.incrementMessagesSinceLLM).toHaveBeenCalled();
    expect(db.incrementMessagesSinceRollup).toHaveBeenCalled();
  });

  it("creates thread edge for threaded replies", async () => {
    await handleMessageIngest([makeJob({ threadTs: "1.0", ts: "1.1" })] as never);

    expect(db.upsertThreadEdge).toHaveBeenCalledWith("default", "C123", "1.0", "1.1");
  });

  it("triggers LLM analysis when gate fires", async () => {
    vi.mocked(evaluateLLMGate).mockReturnValue("threshold");
    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueLLMAnalyze).toHaveBeenCalled();
  });

  it("triggers channel rollup when threshold exceeded", async () => {
    vi.mocked(db.getChannelState).mockResolvedValue({
      id: "cs-1", workspace_id: "default", channel_id: "C123",
      running_summary: "", participants_json: {}, active_threads_json: [],
      key_decisions_json: [], sentiment_snapshot_json: { totalMessages: 0, highRiskCount: 0, updatedAt: "" },
      messages_since_last_llm: 0, last_llm_run_at: null,
      llm_cooldown_until: null, last_reconcile_at: null,
      messages_since_last_rollup: 20, last_rollup_at: null,
      updated_at: new Date(),
    });

    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "channel" }),
    );
  });

  it("triggers thread rollup when reply count exceeds threshold", async () => {
    vi.mocked(db.getThreadReplyCount).mockResolvedValue(10);

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "thread", threadTs: "1.0" }),
    );
  });
});
