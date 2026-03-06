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
  getChannelState: vi.fn().mockResolvedValue(null),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannelState).mockResolvedValue(null);
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
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "Summary text",
      key_decisions_json: ["decision A", "decision B"],
    } as never);

    const result = await assembleContext("ws", "C1", "target", []);

    expect(result.runningSummary).toBe("Summary text");
    expect(result.keyDecisions).toEqual(["decision A", "decision B"]);
  });

  it("skips Layer 3 and redistributes budget when no embedding provider", async () => {
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);

    const messages = [
      { userId: "U1", text: "message one", ts: "1.1" },
      { userId: "U2", text: "message two", ts: "1.2" },
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
      ts: `${i}.0`,
    }));

    const result = await assembleContext("ws", "C1", "target", messages);

    // Should include some but not all messages
    expect(result.recentMessages.length).toBeGreaterThan(0);
    expect(result.recentMessages.length).toBeLessThan(50);
    // Most recent messages should be included (last in the array)
    const lastIncluded = result.recentMessages[result.recentMessages.length - 1];
    expect(parseInt(lastIncluded.ts)).toBe(49);
  });
});
