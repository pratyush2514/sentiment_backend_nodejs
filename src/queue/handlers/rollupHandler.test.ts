import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    LLM_DAILY_BUDGET_USD: 10.0,
    EMBEDDING_MODEL: "text-embedding-3-small",
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
  getLatestContextDocument: vi.fn().mockResolvedValue(null),
  getMessagesSinceTs: vi.fn().mockResolvedValue([]),
  getUserProfiles: vi.fn().mockResolvedValue([]),
  getChannelState: vi.fn().mockResolvedValue(null),
  getMessagesEnriched: vi.fn().mockResolvedValue([]),
  insertContextDocument: vi.fn(),
  upsertChannelState: vi.fn(),
  resetRollupState: vi.fn(),
  insertLLMCost: vi.fn(),
}));

vi.mock("../../services/summarizer.js", () => ({
  channelRollup: vi.fn(),
  threadRollup: vi.fn(),
  backfillSummarize: vi.fn(),
  estimateTokens: vi.fn().mockReturnValue(50),
}));

vi.mock("../../services/embeddingProvider.js", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
}));

vi.mock("../../services/costEstimator.js", () => ({
  estimateCost: vi.fn().mockReturnValue(0.001),
}));

const db = await import("../../db/queries.js");
const { channelRollup, threadRollup } = await import("../../services/summarizer.js");
const { createEmbeddingProvider } = await import("../../services/embeddingProvider.js");
const { handleSummaryRollup } = await import("./rollupHandler.js");

function makeJob(rollupType: string, overrides = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      channelId: "C123",
      rollupType,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getDailyLLMCost).mockResolvedValue(0);
  vi.mocked(createEmbeddingProvider).mockReturnValue(null);
});

describe("handleSummaryRollup", () => {
  it("skips when budget exceeded", async () => {
    vi.mocked(db.getDailyLLMCost).mockResolvedValue(15.0);
    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).not.toHaveBeenCalled();
  });

  it("handles channel rollup: stores doc, updates state, resets counter", async () => {
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
      { ts: "1.2", user_id: "U2", text: "world", normalized_text: "world" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "old summary",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue({
      summary: "Updated summary of discussion",
      keyDecisions: ["decision1"],
      tokenCount: 100,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 200, completionTokens: 100 },
    });

    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        docType: "channel_rollup",
        content: "Updated summary of discussion",
      }),
    );
    expect(db.upsertChannelState).toHaveBeenCalledWith(
      "default", "C123",
      expect.objectContaining({
        running_summary: "Updated summary of discussion",
        key_decisions_json: ["decision1"],
      }),
    );
    expect(db.resetRollupState).toHaveBeenCalled();
    expect(db.insertLLMCost).toHaveBeenCalled();
  });

  it("handles thread rollup: stores doc with thread metadata", async () => {
    vi.mocked(db.getMessagesEnriched).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "thread msg", normalized_text: "thread msg", display_name: null, real_name: "Alice" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "channel context",
    } as never);
    vi.mocked(threadRollup).mockResolvedValue({
      summary: "Thread about feature X",
      keyDecisions: [],
      tokenCount: 50,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    });

    await handleSummaryRollup([makeJob("thread", { threadTs: "1.0" })] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        docType: "thread_rollup",
        sourceThreadTs: "1.0",
      }),
    );
  });

  it("stores doc without embedding when embedding fails", async () => {
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue({
      summary: "Summary",
      keyDecisions: [],
      tokenCount: 50,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    });
    // Embedding provider exists but throws
    vi.mocked(createEmbeddingProvider).mockReturnValue({
      embed: vi.fn().mockRejectedValue(new Error("API error")),
      embedBatch: vi.fn(),
    } as never);

    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null }),
    );
  });
});
