import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../queue/boss.js", () => ({
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-1"),
}));

const boss = await import("../queue/boss.js");
const {
  decideThreadInsightRefresh,
  requestThreadInsightRefresh,
} = await import("./threadInsightRefresh.js");

function recentTs(offsetSeconds = 0): string {
  return String(Date.now() / 1000 - offsetSeconds);
}

describe("threadInsightRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not refresh threads that are outside the analysis window", () => {
    const decision = decideThreadInsightRefresh({
      insight: null,
      latestActivityTs: recentTs(10 * 24 * 60 * 60),
      analysisWindowDays: 7,
    });

    expect(decision).toEqual({
      shouldRefresh: false,
      reason: "outside_analysis_window",
      latestActivityTs: expect.any(String),
    });
  });

  it("refreshes when coverage is stale within the analysis window", () => {
    const decision = decideThreadInsightRefresh({
      insight: { source_ts_end: recentTs(120) },
      latestActivityTs: recentTs(30),
      analysisWindowDays: 7,
    });

    expect(decision).toEqual({
      shouldRefresh: true,
      reason: "stale_coverage",
      latestActivityTs: expect.any(String),
    });
  });

  it("treats singleton-deduped queue requests as non-errors", async () => {
    vi.mocked(boss.enqueueSummaryRollup).mockResolvedValue(null);

    const result = await requestThreadInsightRefresh({
      workspaceId: "default",
      channelId: "C123",
      threadTs: "1710000000.000100",
      insight: null,
      latestActivityTs: recentTs(30),
      analysisWindowDays: 7,
      requestedBy: "messages_route",
    });

    expect(result).toEqual({
      requested: false,
      jobId: null,
      reason: "deduped",
    });
  });
});
