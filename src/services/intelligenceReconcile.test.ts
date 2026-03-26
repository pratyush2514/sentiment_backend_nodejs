import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    QUEUE_STALE_CHANNEL_MINUTES: 10,
    QUEUE_STALE_ANALYSIS_MINUTES: 15,
    INTELLIGENCE_RECONCILE_SCAN_LIMIT: 50,
    INTELLIGENCE_RECONCILE_INTERVAL_MS: 5 * 60 * 1000,
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
  getRecoverableChannels: vi.fn().mockResolvedValue([]),
  getReadyChannels: vi.fn().mockResolvedValue([]),
  getStaleAnalysisCandidates: vi.fn().mockResolvedValue([]),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueBackfill: vi.fn().mockResolvedValue("job-backfill-repair"),
  enqueueLLMAnalyzeBatches: vi.fn().mockResolvedValue([]),
  enqueueSummaryRollup: vi.fn().mockResolvedValue(null),
}));

vi.mock("./intelligenceTruth.js", () => ({
  fetchChannelTruthSnapshots: vi.fn().mockResolvedValue(new Map()),
}));

const db = await import("../db/queries.js");
const bossModule = await import("../queue/boss.js");
const truthModule = await import("./intelligenceTruth.js");
const { runIntelligenceReconcileOnce } = await import("./intelligenceReconcile.js");

describe("runIntelligenceReconcileOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-enqueues ready channels whose truth bootstrap never completed", async () => {
    vi.mocked(db.getReadyChannels).mockResolvedValue([
      {
        workspace_id: "default",
        channel_id: "C123",
        status: "ready",
      },
    ] as never);
    vi.mocked(truthModule.fetchChannelTruthSnapshots).mockResolvedValue(
      new Map([
        [
          "C123",
          {
            ingestReadiness: "not_started",
            intelligenceReadiness: "missing",
            latestSummaryCompleteness: null,
            hasActiveDegradations: false,
            currentSummaryArtifactId: null,
            activeBackfillRunId: null,
            summaryArtifact: null,
            backfillRun: null,
            degradationSignals: [],
          },
        ],
      ]) as never,
    );

    await runIntelligenceReconcileOnce();

    expect(bossModule.enqueueBackfill).toHaveBeenCalledWith(
      "default",
      "C123",
      "intelligence_reconcile",
    );
    expect(bossModule.enqueueSummaryRollup).not.toHaveBeenCalled();
  });
});
