import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    QUEUE_MAINTENANCE_INTERVAL_MS: 30_000,
    QUEUE_STALE_CHANNEL_MINUTES: 10,
    QUEUE_STALE_ANALYSIS_MINUTES: 15,
    QUEUE_STALE_SCAN_LIMIT: 50,
    FATHOM_HISTORICAL_SYNC_STALE_MINUTES: 45,
    LOW_SIGNAL_CHANNEL_NAMES: ["general", "random", "social", "watercooler"],
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
  releaseStaleMeetingDigestClaims: vi.fn().mockResolvedValue([]),
  getRecoverableChannels: vi.fn().mockResolvedValue([]),
  getRecoverableTieredChannels: vi.fn().mockResolvedValue([]),
  getStaleFathomHistoricalSyncs: vi.fn().mockResolvedValue([]),
  markStaleBackfillMessagesSkipped: vi.fn().mockResolvedValue([]),
  getStaleAnalysisCandidates: vi.fn().mockResolvedValue([]),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  getChannel: vi.fn().mockResolvedValue({
    id: "channel-1",
    workspace_id: "default",
    channel_id: "C123",
    name: "sage_team",
    conversation_type: "public_channel",
    status: "ready",
    initialized_at: new Date(),
    last_event_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }),
}));

vi.mock("../queue/boss.js", () => ({
  getQueue: vi.fn(),
  getQueueRuntimeState: vi.fn().mockReturnValue({
    started: true,
    workersRegistered: true,
  }),
  enqueueBackfill: vi.fn().mockResolvedValue("job-backfill-recovery"),
  enqueueBackfillTier1: vi.fn().mockResolvedValue("job-tiered-recovery"),
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-recovery"),
}));

vi.mock("./fathomHistoricalSyncRecovery.js", () => ({
  recoverHistoricalSyncLease: vi.fn().mockResolvedValue({
    recovered: false,
    connection: null,
    error: null,
  }),
}));

const db = await import("../db/queries.js");
const bossModule = await import("../queue/boss.js");
const fathomRecovery = await import("./fathomHistoricalSyncRecovery.js");
const { runQueueMaintenanceOnce } = await import("./queueMaintenance.js");

function makeFailedJob(id: string) {
  const now = new Date();

  return {
    id,
    name: "summary.rollup",
    data: {},
    expireInSeconds: 60,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "failed",
    retryLimit: 2,
    retryCount: 2,
    retryDelay: 30,
    retryBackoff: true,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 60,
    createdOn: now,
    completedOn: now,
    keepUntil: now,
    policy: "standard",
    heartbeatOn: null,
    deadLetter: "",
    output: {},
  };
}

describe("runQueueMaintenanceOnce", () => {
  const fakeBoss = {
    supervise: vi.fn().mockResolvedValue(undefined),
    findJobs: vi.fn(),
    retry: vi.fn().mockResolvedValue({ jobs: ["failed-job-1"], requested: 1, affected: 1 }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bossModule.getQueueRuntimeState).mockReturnValue({
      started: true,
      workersRegistered: true,
    } as never);
    vi.mocked(bossModule.getQueue).mockReturnValue(fakeBoss as never);
    vi.mocked(db.getStaleFathomHistoricalSyncs).mockResolvedValue([]);
    vi.mocked(fathomRecovery.recoverHistoricalSyncLease).mockResolvedValue({
      recovered: false,
      connection: null,
      error: null,
    } as never);
    fakeBoss.findJobs.mockImplementation(async (queueName: string) => (
      queueName === "summary.rollup" ? [makeFailedJob("failed-job-1")] : []
    ));
  });

  it("retries recent failed jobs and re-enqueues stale channel and artifact scopes", async () => {
    vi.mocked(db.getRecoverableChannels).mockResolvedValue([
      {
        workspace_id: "default",
        channel_id: "C123",
        status: "failed",
      },
    ] as never);
    vi.mocked(db.markStaleBackfillMessagesSkipped).mockResolvedValue([
      {
        workspace_id: "default",
        channel_id: "C123",
        skipped_count: 4,
      },
    ] as never);
    vi.mocked(db.getStaleAnalysisCandidates).mockResolvedValue([
      {
        workspace_id: "default",
        channel_id: "C123",
        ts: "1.1",
        thread_ts: "1.0",
        analysis_status: "failed",
      },
      {
        workspace_id: "default",
        channel_id: "C123",
        ts: "1.2",
        thread_ts: "1.0",
        analysis_status: "pending",
      },
    ] as never);

    await runQueueMaintenanceOnce();

    expect(fakeBoss.supervise).toHaveBeenCalled();
    expect(fakeBoss.retry).toHaveBeenCalledWith("summary.rollup", "failed-job-1");
    expect(bossModule.enqueueBackfill).toHaveBeenCalledWith(
      "default",
      "C123",
      "maintenance-recovery",
    );
    expect(bossModule.enqueueSummaryRollup).toHaveBeenCalledTimes(1);
    expect(bossModule.enqueueSummaryRollup).toHaveBeenCalledWith({
      workspaceId: "default",
      channelId: "C123",
      threadTs: "1.0",
      rollupType: "thread",
      requestedBy: "manual",
    });
  });

  it("quietly skips when pg-boss is shutting down", async () => {
    fakeBoss.supervise.mockRejectedValueOnce(
      new Error("Database connection is not opened"),
    );

    await expect(runQueueMaintenanceOnce()).resolves.toBeUndefined();
  });

  it("requeues stale Fathom historical sync leases during maintenance", async () => {
    vi.mocked(db.getStaleFathomHistoricalSyncs).mockResolvedValue([
      {
        workspace_id: "default",
        historical_sync_status: "running",
      },
    ] as never);
    vi.mocked(fathomRecovery.recoverHistoricalSyncLease).mockResolvedValue({
      recovered: true,
      connection: null,
      error: null,
    } as never);

    await runQueueMaintenanceOnce();

    expect(vi.mocked(fathomRecovery.recoverHistoricalSyncLease)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        requestedBy: "maintenance",
        reason: "queue_maintenance",
      }),
    );
  });
});
