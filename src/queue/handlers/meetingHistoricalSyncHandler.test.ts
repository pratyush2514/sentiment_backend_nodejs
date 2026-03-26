import { beforeEach, describe, expect, it, vi } from "vitest";

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
  markFathomHistoricalSyncRunning: vi.fn().mockResolvedValue(undefined),
  listExistingMeetingCallIds: vi.fn().mockResolvedValue(new Set()),
  completeFathomHistoricalSync: vi.fn().mockResolvedValue(undefined),
  failFathomHistoricalSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/fathomClient.js", () => ({
  fetchMeetingDetails: vi.fn().mockResolvedValue([]),
  getMeetingIdentifier: vi.fn((item: Record<string, unknown>) => {
    return typeof item.recording_id === "string" ? item.recording_id : null;
  }),
}));

vi.mock("../../services/fathomLinkDetector.js", () => ({
  backfillHistoricalFathomLinks: vi.fn().mockResolvedValue({
    scannedMessageCount: 0,
    uniqueShareLinkCount: 0,
    importQueuedCount: 0,
  }),
}));

vi.mock("../boss.js", () => ({
  enqueueMeetingIngest: vi.fn().mockResolvedValue("job-meeting-ingest-1"),
}));

const db = await import("../../db/queries.js");
const fathomClient = await import("../../services/fathomClient.js");
const fathomLinkDetector = await import("../../services/fathomLinkDetector.js");
const boss = await import("../boss.js");
const { handleMeetingHistoricalSync } = await import("./meetingHistoricalSyncHandler.js");

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      windowDays: 14,
      requestedBy: "manual" as const,
      ...overrides,
    },
  };
}

describe("handleMeetingHistoricalSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.markFathomHistoricalSyncRunning).mockResolvedValue(undefined);
    vi.mocked(db.listExistingMeetingCallIds).mockResolvedValue(new Set());
    vi.mocked(db.completeFathomHistoricalSync).mockResolvedValue(undefined);
    vi.mocked(db.failFathomHistoricalSync).mockResolvedValue(undefined);
    vi.mocked(fathomClient.fetchMeetingDetails).mockResolvedValue([]);
    vi.mocked(fathomLinkDetector.backfillHistoricalFathomLinks).mockResolvedValue({
      scannedMessageCount: 0,
      uniqueShareLinkCount: 0,
      importQueuedCount: 0,
    } as never);
    vi.mocked(boss.enqueueMeetingIngest).mockResolvedValue("job-meeting-ingest-1");
  });

  it("imports only missing unique meetings from the requested historical window", async () => {
    vi.mocked(fathomClient.fetchMeetingDetails).mockResolvedValue([
      { recording_id: "call-1" },
      { recording_id: "call-2" },
      { recording_id: "call-1" },
      { recording_id: "call-3" },
    ] as never);
    vi.mocked(db.listExistingMeetingCallIds).mockResolvedValue(
      new Set(["call-2"]) as never,
    );

    await handleMeetingHistoricalSync([makeJob()] as never);

    expect(vi.mocked(db.markFathomHistoricalSyncRunning)).toHaveBeenCalledWith(
      "default",
      14,
    );
    expect(
      vi.mocked(fathomLinkDetector.backfillHistoricalFathomLinks),
    ).toHaveBeenCalledWith("default", 14, {
      prefetchedMeetings: [
        { recording_id: "call-1" },
        { recording_id: "call-2" },
        { recording_id: "call-1" },
        { recording_id: "call-3" },
      ],
    });
    expect(vi.mocked(db.listExistingMeetingCallIds)).toHaveBeenCalledWith(
      "default",
      ["call-1", "call-2", "call-3"],
    );
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenNthCalledWith(1, {
      workspaceId: "default",
      fathomCallId: "call-1",
      source: "refetch",
      importMode: "historical",
    });
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenNthCalledWith(2, {
      workspaceId: "default",
      fathomCallId: "call-3",
      source: "refetch",
      importMode: "historical",
    });
    expect(vi.mocked(db.completeFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      {
        windowDays: 14,
        discoveredCount: 3,
        importedCount: 2,
      },
    );
  });

  it("includes slack-link triggered imports in the historical sync imported count", async () => {
    vi.mocked(fathomClient.fetchMeetingDetails).mockResolvedValue([
      { recording_id: "call-1" },
      { recording_id: "call-2" },
    ] as never);
    vi.mocked(fathomLinkDetector.backfillHistoricalFathomLinks).mockResolvedValue({
      scannedMessageCount: 2,
      uniqueShareLinkCount: 1,
      importQueuedCount: 1,
    } as never);
    vi.mocked(db.listExistingMeetingCallIds).mockResolvedValue(
      new Set(["call-1"]) as never,
    );

    await handleMeetingHistoricalSync([makeJob()] as never);

    expect(vi.mocked(db.completeFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      {
        windowDays: 14,
        discoveredCount: 2,
        importedCount: 2,
      },
    );
  });
});
