import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    FATHOM_ENABLED: true,
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
  getMeetingByExternalUrl: vi.fn().mockResolvedValue(null),
  getMeetingChannelLinkByChannelId: vi.fn().mockResolvedValue(null),
  updateMeetingChannelId: vi.fn().mockResolvedValue(undefined),
  getMeeting: vi.fn().mockResolvedValue(null),
  getMeetingObligations: vi.fn().mockResolvedValue([]),
  listMessagesWithFathomLinksInWindow: vi.fn().mockResolvedValue([]),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueMeetingIngest: vi.fn().mockResolvedValue("job-meeting-ingest-1"),
}));

vi.mock("./fathomClient.js", () => ({
  fetchMeetingByShareUrl: vi.fn().mockResolvedValue(null),
  getMeetingIdentifier: vi.fn((item: Record<string, unknown>) => {
    if (typeof item.recordingId === "number") return String(item.recordingId);
    if (typeof item.recording_id === "string") return item.recording_id;
    return null;
  }),
}));

vi.mock("./fathomSharePage.js", () => ({
  fetchMeetingFromSharePage: vi.fn().mockResolvedValue(null),
}));

vi.mock("./meetingPipeline.js", () => ({
  resumeMeetingPipeline: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./intelligenceTruth.js", () => ({
  recordIntelligenceDegradation: vi.fn().mockResolvedValue(undefined),
}));

const postSlackMessage = vi.fn().mockResolvedValue({ ok: true, ts: "123.456" });

vi.mock("./slackClientFactory.js", () => ({
  getSlackClient: vi.fn().mockResolvedValue({
    postSlackMessage,
  }),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const fathomClient = await import("./fathomClient.js");
const fathomSharePage = await import("./fathomSharePage.js");
const meetingPipeline = await import("./meetingPipeline.js");
const intelligenceTruth = await import("./intelligenceTruth.js");
const {
  backfillHistoricalFathomLinks,
  detectFathomLinks,
} = await import("./fathomLinkDetector.js");

describe("detectFathomLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getMeetingByExternalUrl).mockResolvedValue(null as never);
    vi.mocked(db.listMessagesWithFathomLinksInWindow).mockResolvedValue([] as never);
    vi.mocked(fathomClient.fetchMeetingByShareUrl).mockResolvedValue(null as never);
    vi.mocked(fathomSharePage.fetchMeetingFromSharePage).mockResolvedValue(
      null as never,
    );
    vi.mocked(boss.enqueueMeetingIngest).mockResolvedValue(
      "job-meeting-ingest-1" as never,
    );
    postSlackMessage.mockResolvedValue({ ok: true, ts: "123.456" });
  });

  it("imports an unknown shared Fathom meeting into the current channel and posts a preview", async () => {
    vi.mocked(fathomClient.fetchMeetingByShareUrl).mockResolvedValue({
      title: "Sage - Kick Off Call",
      recordingId: 202,
      shareUrl: "https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      url: "https://fathom.video/recording/202",
      recordingStartTime: new Date("2026-03-25T07:00:00.000Z"),
      recordingEndTime: new Date("2026-03-25T07:30:00.000Z"),
      calendarInvitees: [{ name: "Client", email: "client@sage.com" }],
      defaultSummary: {
        markdownFormatted: "Client is concerned about launch timing.",
      },
      actionItems: [
        {
          description: "Send revised launch timeline",
          assignee: { name: "Sid" },
        },
      ],
    } as never);

    await detectFathomLinks(
      "workspace-1",
      "C_SAGE",
      "Yesterday's call https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      "U123",
      "1742890000.000100",
    );

    expect(vi.mocked(fathomClient.fetchMeetingByShareUrl)).toHaveBeenCalledWith(
      "workspace-1",
      "https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
    );
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      fathomCallId: "202",
      source: "refetch",
      importMode: "live",
      channelIdHint: "C_SAGE",
      payload: expect.objectContaining({
        title: "Sage - Kick Off Call",
      }),
    });
    expect(postSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C_SAGE",
        threadTs: "1742890000.000100",
      }),
    );
    expect(
      vi.mocked(intelligenceTruth.recordIntelligenceDegradation),
    ).not.toHaveBeenCalled();
  });

  it("records a degradation when an unknown shared Fathom meeting cannot be fetched", async () => {
    await detectFathomLinks(
      "workspace-1",
      "C_SAGE",
      "Yesterday's call https://fathom.video/share/missing-share-id",
      "U123",
      "1742890000.000100",
    );

    expect(
      vi.mocked(intelligenceTruth.recordIntelligenceDegradation),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channelId: "C_SAGE",
        eventType: "fathom_channel_link_missing",
      }),
    );
  });

  it("falls back to the public share page when the API cannot access the meeting", async () => {
    vi.mocked(fathomSharePage.fetchMeetingFromSharePage).mockResolvedValue({
      meetingSource: "shared_link",
      title: "Sage - Kick Off Call",
      shareUrl: "https://fathom.video/share/missing-share-id",
      recordingStartTime: "2026-03-25T07:00:00.000Z",
      durationSeconds: 1800,
      defaultSummary: {
        markdownFormatted: "Client is worried about timeline and wants a revised plan.",
      },
      highlights: ["Client wants a revised plan this week."],
    } as never);

    await detectFathomLinks(
      "workspace-1",
      "C_SAGE",
      "Yesterday's call https://fathom.video/share/missing-share-id",
      "U123",
      "1742890000.000100",
    );

    expect(vi.mocked(fathomClient.fetchMeetingByShareUrl)).toHaveBeenCalledWith(
      "workspace-1",
      "https://fathom.video/share/missing-share-id",
    );
    expect(
      vi.mocked(fathomSharePage.fetchMeetingFromSharePage),
    ).toHaveBeenCalledWith(
      "https://fathom.video/share/missing-share-id",
      {
        fallbackStartedAt: "2025-03-25T08:06:40.000Z",
      },
    );
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      fathomCallId: "share:missing-share-id",
      source: "shared_link",
      importMode: "live",
      channelIdHint: "C_SAGE",
      payload: expect.objectContaining({
        title: "Sage - Kick Off Call",
        meetingSource: "shared_link",
      }),
    });
    expect(
      vi.mocked(intelligenceTruth.recordIntelligenceDegradation),
    ).not.toHaveBeenCalled();
  });

  it("backfills historical Slack-shared Fathom links without posting into old Slack threads", async () => {
    vi.mocked(db.listMessagesWithFathomLinksInWindow).mockResolvedValue([
      {
        channel_id: "C_SAGE",
        ts: "1742890000.000100",
        user_id: "U123",
        text: "Yesterday's call https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      },
      {
        channel_id: "C_SAGE",
        ts: "1742890100.000200",
        user_id: "U456",
        text: "Sharing again https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      },
    ] as never);

    const result = await backfillHistoricalFathomLinks("workspace-1", 14, {
      prefetchedMeetings: [
        {
          title: "Sage - Kick Off Call",
          recordingId: 202,
          shareUrl: "https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
        },
      ],
    });

    expect(result).toEqual({
      scannedMessageCount: 2,
      uniqueShareLinkCount: 1,
      importQueuedCount: 1,
    });
    expect(vi.mocked(boss.enqueueMeetingIngest)).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it("promotes a historical stored meeting into the live pipeline when the link is shared again", async () => {
    vi.mocked(db.getMeetingByExternalUrl).mockResolvedValue({
      id: "meeting-1",
      workspace_id: "workspace-1",
      fathom_call_id: "202",
      meeting_source: "api",
      channel_id: null,
      title: "Sage - Kick Off Call",
      started_at: new Date("2026-03-25T07:00:00.000Z"),
      ended_at: new Date("2026-03-25T07:30:00.000Z"),
      duration_seconds: 1800,
      participants_json: [],
      fathom_summary: "Client is concerned about launch timing.",
      fathom_action_items_json: [],
      fathom_highlights_json: [],
      recording_url: "https://fathom.video/recording/202",
      share_url: "https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      transcript_text: null,
      meeting_sentiment: null,
      risk_signals_json: [],
      processing_status: "pending",
      extraction_status: "not_run",
      digest_posted_at: null,
      digest_claimed_at: null,
      digest_message_ts: null,
      digest_thread_ts: null,
      digest_enabled: true,
      tracking_enabled: true,
      duplicate_of_meeting_id: null,
      import_mode: "historical",
      last_error: null,
      attempt_count: 0,
      created_at: new Date("2026-03-25T07:00:00.000Z"),
      updated_at: new Date("2026-03-25T07:00:00.000Z"),
    } as never);

    await detectFathomLinks(
      "workspace-1",
      "C_SAGE",
      "Yesterday's call https://fathom.video/share/5ATWHN5mCZNGA7z4qPeRhiGJ7xxALT62",
      "U123",
      "1742890000.000100",
      { suppressSlackReplies: true },
    );

    expect(vi.mocked(db.updateMeetingChannelId)).toHaveBeenCalledWith(
      "workspace-1",
      "meeting-1",
      "C_SAGE",
      {
        digestEnabled: true,
        trackingEnabled: true,
        importMode: "live",
      },
    );
    expect(vi.mocked(meetingPipeline.resumeMeetingPipeline)).toHaveBeenCalledWith(
      "workspace-1",
      "meeting-1",
    );
  });
});
