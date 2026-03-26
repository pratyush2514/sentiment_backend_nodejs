import { beforeEach, describe, expect, it, vi } from "vitest";

const listMeetingsMock = vi.fn();

vi.mock("fathom-typescript", () => ({
  Fathom: class MockFathom {
    listMeetings = listMeetingsMock;
  },
}));

vi.mock("../db/queries.js", () => ({
  updateFathomConnectionSyncedAt: vi.fn().mockResolvedValue(undefined),
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

vi.mock("./fathomTokenManager.js", () => ({
  getFathomApiKey: vi.fn().mockResolvedValue("fathom_api_key"),
  invalidateFathomConnection: vi.fn().mockResolvedValue(undefined),
  storeFathomWebhookSecret: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("../db/queries.js");
const {
  fetchMeetingByCallId,
  fetchMeetingDetails,
  fetchMeetingByShareUrl,
} = await import("./fathomClient.js");

function makeMeetingIterator(
  pages: Array<{ result: { items: unknown[] } }>,
): {
  next: () => Promise<{ result: { items: unknown[] } } | null>;
  [Symbol.asyncIterator]: () => AsyncIterableIterator<{ result: { items: unknown[] } }>;
} & { result: { items: unknown[] } } {
  const [firstPage, ...restPages] = pages;
  return {
    ...(firstPage ?? { result: { items: [] } }),
    next: async () => restPages.shift() ?? null,
    [Symbol.asyncIterator]: async function* paginator() {
      for (const page of pages) {
        yield page;
      }
    },
  };
}

describe("fathomClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMeetingsMock.mockResolvedValue(
      makeMeetingIterator([{ result: { items: [] } }]),
    );
  });

  it("aggregates meeting items across paginated Fathom responses", async () => {
    listMeetingsMock.mockResolvedValue(
      makeMeetingIterator([
        {
          result: {
            items: [{ recording_id: "call-1" }, { recording_id: "call-2" }],
          },
        },
        {
          result: {
            items: [{ recording_id: "call-3" }],
          },
        },
      ]),
    );

    const meetings = await fetchMeetingDetails("workspace-1", {
      createdAfter: "2026-03-12T00:00:00.000Z",
    });

    expect(listMeetingsMock).toHaveBeenCalledWith({
      createdAfter: "2026-03-12T00:00:00.000Z",
      includeActionItems: true,
      includeSummary: true,
      includeTranscript: true,
    });
    expect(meetings).toEqual([
      { recording_id: "call-1" },
      { recording_id: "call-2" },
      { recording_id: "call-3" },
    ]);
    expect(vi.mocked(db.updateFathomConnectionSyncedAt)).toHaveBeenCalledWith(
      "workspace-1",
    );
  });

  it("finds a specific meeting by call id from the paginated meeting list", async () => {
    listMeetingsMock.mockResolvedValue(
      makeMeetingIterator([
        {
          result: {
            items: [{ recordingId: 101 }, { recordingId: 202 }],
          },
        },
      ]),
    );

    const meeting = await fetchMeetingByCallId("workspace-1", "202");

    expect(meeting).toEqual({ recordingId: 202 });
  });

  it("finds a specific meeting by exact share url from the paginated meeting list", async () => {
    listMeetingsMock.mockResolvedValue(
      makeMeetingIterator([
        {
          result: {
            items: [
              { shareUrl: "https://fathom.video/share/a1", recordingId: 101 },
              { shareUrl: "https://fathom.video/share/a2", recordingId: 202 },
            ],
          },
        },
      ]),
    );

    const meeting = await fetchMeetingByShareUrl(
      "workspace-1",
      "https://fathom.video/share/a2",
    );

    expect(meeting).toEqual({
      shareUrl: "https://fathom.video/share/a2",
      recordingId: 202,
    });
  });
});
