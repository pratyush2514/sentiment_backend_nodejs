import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    CONTEXT_TOKEN_BUDGET: 1000,
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../db/queries.js", () => ({
  getEffectiveAnalysisWindowDays: vi.fn().mockResolvedValue(7),
  getChannelState: vi.fn().mockResolvedValue(null),
  getLatestContextDocument: vi.fn().mockResolvedValue(null),
  getMessagesInWindow: vi.fn().mockResolvedValue([]),
  searchContextDocuments: vi.fn().mockResolvedValue([]),
}));

vi.mock("./embeddingProvider.js", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
}));

vi.mock("./summarizer.js", () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  truncateToTokens: vi.fn((text: string, maxTokens: number) => {
    const maxChars = maxTokens * 4;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }),
}));

const db = await import("../db/queries.js");
const { createEmbeddingProvider } = await import("./embeddingProvider.js");
const { assembleContext } = await import("./contextAssembler.js");

function recentTs(offsetSeconds = 0): string {
  return String(Date.now() / 1000 - offsetSeconds);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getEffectiveAnalysisWindowDays).mockResolvedValue(7);
  vi.mocked(db.getChannelState).mockResolvedValue(null);
  vi.mocked(db.getLatestContextDocument).mockResolvedValue(null);
  vi.mocked(db.getMessagesInWindow).mockResolvedValue([]);
  vi.mocked(createEmbeddingProvider).mockReturnValue(null);
});

describe("assembleContext", () => {
  it("returns empty defaults when no channel state exists", async () => {
    const result = await assembleContext("ws", "C1", "target", []);

    expect(result.runningSummary).toBe("");
    expect(result.keyDecisions).toEqual([]);
    expect(result.relevantDocuments).toEqual([]);
    expect(result.recentMessages).toEqual([]);
  });

  it("includes running summary and key decisions from channel state", async () => {
    vi.mocked(db.getLatestContextDocument).mockResolvedValueOnce({
      source_ts_start: String(Date.now() / 1000),
      source_ts_end: String(Date.now() / 1000),
      created_at: new Date(),
    } as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "Summary text",
      key_decisions_json: ["decision A", "decision B"],
    } as never);

    const result = await assembleContext("ws", "C1", "target", []);

    expect(result.runningSummary).toBe("Summary text");
    expect(result.keyDecisions).toEqual(["decision A", "decision B"]);
  });

  it("drops stale summary state when coverage predates the analysis window", async () => {
    vi.mocked(db.getLatestContextDocument).mockResolvedValueOnce({
      source_ts_start: "1.0",
      source_ts_end: "2.0",
      created_at: new Date(0),
    } as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "Old summary text",
      key_decisions_json: ["old decision"],
    } as never);

    const result = await assembleContext("ws", "C1", "target", []);

    expect(result.runningSummary).toBe("");
    expect(result.keyDecisions).toEqual([]);
  });

  it("skips Layer 3 and redistributes budget when no embedding provider", async () => {
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);

    const messages = [
      { userId: "U1", text: "message one", ts: recentTs(30) },
      { userId: "U2", text: "message two", ts: recentTs(10) },
    ];

    const result = await assembleContext("ws", "C1", "target", messages);

    // No embedding provider → Layer 3 budget flows to Layer 4
    expect(result.relevantDocuments).toEqual([]);
    // Messages should be packed (Layer 4 gets extra budget from Layer 3)
    expect(result.recentMessages.length).toBeGreaterThan(0);
  });

  it("packs recent messages newest-first up to budget", async () => {
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);

    // Create messages that exceed budget to test truncation
    const messages = Array.from({ length: 50 }, (_, i) => ({
      userId: `U${i}`,
      text: `This is a relatively long message number ${i} that takes up some token budget space`,
      ts: recentTs(50 - i),
    }));

    const result = await assembleContext("ws", "C1", "target", messages);

    // Should include some but not all messages
    expect(result.recentMessages.length).toBeGreaterThan(0);
    expect(result.recentMessages.length).toBeLessThan(50);
    // Most recent messages should be included (last in the array)
    const lastIncluded = result.recentMessages[result.recentMessages.length - 1];
    expect(lastIncluded.ts).toBe(messages[messages.length - 1]?.ts);
  });
});
