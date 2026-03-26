import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FathomConnectionRow } from "../types/database.js";

vi.mock("../config.js", () => ({
  config: {
    FATHOM_HISTORICAL_SYNC_STALE_MINUTES: 45,
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
  failFathomHistoricalSync: vi.fn().mockResolvedValue(undefined),
  queueFathomHistoricalSync: vi.fn(),
  getFathomConnection: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueMeetingHistoricalSync: vi.fn().mockResolvedValue("job-meeting-historical-1"),
  getQueue: vi.fn(),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const {
  isHistoricalSyncLeaseStale,
  recoverHistoricalSyncLease,
} = await import("./fathomHistoricalSyncRecovery.js");

function makeConnection(
  overrides: Partial<FathomConnectionRow> = {},
): FathomConnectionRow {
  return {
    id: "fathom-1",
    workspace_id: "default",
    fathom_user_email: "owner@example.com",
    encrypted_api_key: "enc",
    webhook_id: "wh_123",
    webhook_secret: "secret",
    status: "active",
    default_channel_id: null,
    last_synced_at: null,
    last_error: null,
    historical_sync_status: "running",
    historical_sync_window_days: 14,
    historical_sync_started_at: new Date(Date.now() - 60 * 60 * 1000),
    historical_sync_completed_at: null,
    historical_sync_discovered_count: 4,
    historical_sync_imported_count: 2,
    historical_sync_last_error: null,
    created_at: new Date(),
    updated_at: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
}

describe("fathomHistoricalSyncRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(boss.getQueue).mockReturnValue({
      findJobs: vi.fn().mockResolvedValue([]),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(db.queueFathomHistoricalSync).mockResolvedValue(
      makeConnection({
        historical_sync_status: "queued",
        historical_sync_started_at: null,
        historical_sync_discovered_count: 0,
        historical_sync_imported_count: 0,
        updated_at: new Date(),
      }) as never,
    );
    vi.mocked(db.getFathomConnection).mockResolvedValue(
      makeConnection({
        historical_sync_status: "queued",
        historical_sync_started_at: null,
        historical_sync_discovered_count: 0,
        historical_sync_imported_count: 0,
        updated_at: new Date(),
      }) as never,
    );
  });

  it("detects stale queued or running historical sync leases", () => {
    expect(
      isHistoricalSyncLeaseStale(
        makeConnection({
          historical_sync_status: "running",
          historical_sync_started_at: new Date(Date.now() - 60 * 60 * 1000),
        }),
      ),
    ).toBe(true);
    expect(
      isHistoricalSyncLeaseStale(
        makeConnection({
          historical_sync_status: "queued",
          updated_at: new Date(Date.now() - 60 * 60 * 1000),
        }),
      ),
    ).toBe(true);
    expect(
      isHistoricalSyncLeaseStale(
        makeConnection({
          historical_sync_status: "running",
          historical_sync_started_at: new Date(),
        }),
      ),
    ).toBe(false);
  });

  it("fails and requeues a stale historical sync lease", async () => {
    const result = await recoverHistoricalSyncLease({
      workspaceId: "default",
      connection: makeConnection(),
      requestedBy: "maintenance",
      reason: "queue_maintenance",
    });

    expect(vi.mocked(db.failFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        lastError: "historical_sync_stalled:queue_maintenance",
      }),
    );
    expect(vi.mocked(db.queueFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      14,
    );
    expect(vi.mocked(boss.enqueueMeetingHistoricalSync)).toHaveBeenCalledWith({
      workspaceId: "default",
      windowDays: 14,
      requestedBy: "maintenance",
    });
    expect(result).toEqual(
      expect.objectContaining({
        recovered: true,
        error: null,
      }),
    );
  });
});
