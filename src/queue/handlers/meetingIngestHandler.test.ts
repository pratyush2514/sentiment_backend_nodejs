import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    PRIVACY_MODE: "off",
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
  getMeetingByFathomCallId: vi.fn().mockResolvedValue(null),
  getMeetingByExternalUrl: vi.fn().mockResolvedValue(null),
  promoteSharedLinkMeeting: vi.fn().mockResolvedValue(null),
  listMeetings: vi.fn().mockResolvedValue({ meetings: [], total: 0 }),
  upsertMeeting: vi.fn().mockResolvedValue({ id: "meeting-1" }),
  updateMeetingProcessingStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/fathomClient.js", () => ({
  fetchMeetingByCallId: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/intelligenceTruth.js", () => ({
  recordIntelligenceDegradation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/privacyFilter.js", () => ({
  sanitizeForExternalUse: vi.fn((text: string) => ({
    action: "allowed",
    text,
  })),
}));

vi.mock("../../services/meetingChannelResolver.js", () => ({
  resolveChannelForMeeting: vi.fn().mockResolvedValue({
    channelId: "C123",
    digestEnabled: true,
    trackingEnabled: true,
    matchedBy: "rule",
  }),
}));

vi.mock("../boss.js", () => ({
  enqueueMeetingExtract: vi.fn().mockResolvedValue("job-meeting-extract-1"),
}));

const db = await import("../../db/queries.js");
const fathomClient = await import("../../services/fathomClient.js");
const boss = await import("../boss.js");
const { handleMeetingIngest } = await import("./meetingIngestHandler.js");

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "workspace-1",
      fathomCallId: "202",
      source: "refetch" as const,
      importMode: "historical" as const,
      ...overrides,
    },
  };
}

describe("handleMeetingIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getMeetingByFathomCallId).mockResolvedValue(null as never);
    vi.mocked(db.getMeetingByExternalUrl).mockResolvedValue(null as never);
    vi.mocked(db.promoteSharedLinkMeeting).mockResolvedValue(null as never);
    vi.mocked(db.listMeetings).mockResolvedValue({ meetings: [], total: 0 } as never);
    vi.mocked(db.upsertMeeting).mockResolvedValue({ id: "meeting-1" } as never);
    vi.mocked(fathomClient.fetchMeetingByCallId).mockResolvedValue(null as never);
    vi.mocked(boss.enqueueMeetingExtract).mockResolvedValue(
      "job-meeting-extract-1" as never,
    );
  });

  it("parses SDK-shaped Fathom meetings during historical refetch ingest", async () => {
    vi.mocked(fathomClient.fetchMeetingByCallId).mockResolvedValue({
      title: "Sage weekly sync",
      recordingId: 202,
      shareUrl: "https://fathom.video/share/202",
      url: "https://fathom.video/recording/202",
      recordingStartTime: new Date("2026-03-24T10:00:00.000Z"),
      recordingEndTime: new Date("2026-03-24T10:30:00.000Z"),
      calendarInvitees: [
        { name: "Client One", email: "client@sage.com" },
        { name: "Pratyush", email: "pratyush@pulseboard.ai" },
      ],
      recordedBy: { name: "Pratyush", email: "pratyush@pulseboard.ai" },
      defaultSummary: {
        markdownFormatted: "Discussed blockers and weekly plan.",
      },
      actionItems: [
        {
          description: "Send updated timeline",
          assignee: { name: "Pratyush" },
        },
      ],
      transcript: [
        {
          timestamp: "00:01:05",
          text: "We need to fix the blocker this week.",
          speaker: { displayName: "Client One" },
        },
      ],
    } as never);

    await handleMeetingIngest([makeJob()] as never);

    expect(vi.mocked(db.upsertMeeting)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        fathomCallId: "202",
        meetingSource: "api",
        title: "Sage weekly sync",
        startedAt: "2026-03-24T10:00:00.000Z",
        endedAt: "2026-03-24T10:30:00.000Z",
        recordingUrl: "https://fathom.video/recording/202",
        shareUrl: "https://fathom.video/share/202",
        fathomSummary: "Discussed blockers and weekly plan.",
        importMode: "historical",
      }),
    );
    expect(vi.mocked(boss.enqueueMeetingExtract)).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    });
  });

  it("keeps shared-link fallback meetings context-only and skips extraction", async () => {
    await handleMeetingIngest([
      makeJob({
        fathomCallId: "share:shared-123",
        source: "shared_link",
        payload: {
          meetingSource: "shared_link",
          title: "Sage - Kick Off Call",
          shareUrl: "https://fathom.video/share/shared-123",
          recordingStartTime: "2026-03-24T10:00:00.000Z",
          durationSeconds: 1800,
          defaultSummary: {
            markdownFormatted: "Discussed delivery plan and next checkpoint.",
          },
        },
      }),
    ] as never);

    expect(vi.mocked(db.upsertMeeting)).toHaveBeenCalledWith(
      expect.objectContaining({
        fathomCallId: "share:shared-123",
        meetingSource: "shared_link",
        processingStatus: "completed",
      }),
    );
    expect(vi.mocked(boss.enqueueMeetingExtract)).not.toHaveBeenCalled();
  });

  it("refetches incomplete webhook payloads before ingesting them", async () => {
    vi.mocked(fathomClient.fetchMeetingByCallId).mockResolvedValue({
      title: "Webhook-backed sync",
      recordingId: 202,
      shareUrl: "https://fathom.video/share/202",
      url: "https://fathom.video/recording/202",
      recordingStartTime: new Date("2026-03-24T10:00:00.000Z"),
      recordingEndTime: new Date("2026-03-24T10:30:00.000Z"),
      calendarInvitees: [{ name: "Client One", email: "client@sage.com" }],
      defaultSummary: {
        markdownFormatted: "Discussed launch blockers and next steps.",
      },
      actionItems: [],
      transcript: [],
    } as never);

    await handleMeetingIngest([
      makeJob({
        source: "webhook",
        importMode: "live",
        payload: {
          recording_id: "202",
        },
      }),
    ] as never);

    expect(vi.mocked(fathomClient.fetchMeetingByCallId)).toHaveBeenCalledWith(
      "workspace-1",
      "202",
    );
    expect(vi.mocked(db.upsertMeeting)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        fathomCallId: "202",
        meetingSource: "webhook",
        startedAt: "2026-03-24T10:00:00.000Z",
        importMode: "live",
      }),
    );
    expect(vi.mocked(boss.enqueueMeetingExtract)).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    });
  });

  it("treats live shared-link meetings like first-class live imports", async () => {
    await handleMeetingIngest([
      makeJob({
        fathomCallId: "share:live-123",
        source: "shared_link",
        importMode: "live",
        payload: {
          meetingSource: "shared_link",
          title: "Sage - Launch Review",
          shareUrl: "https://fathom.video/share/live-123",
          recordingStartTime: "2026-03-24T10:00:00.000Z",
          durationSeconds: 1800,
          defaultSummary: {
            markdownFormatted: "Discussed launch blockers and follow-up owners.",
          },
        },
      }),
    ] as never);

    expect(vi.mocked(db.upsertMeeting)).toHaveBeenCalledWith(
      expect.objectContaining({
        fathomCallId: "share:live-123",
        meetingSource: "shared_link",
        processingStatus: "extracting",
        importMode: "live",
      }),
    );
    expect(vi.mocked(boss.enqueueMeetingExtract)).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    });
  });

  it("promotes a provisional shared-link meeting when the real API meeting arrives", async () => {
    vi.mocked(db.getMeetingByExternalUrl).mockResolvedValue({
      id: "meeting-shared",
      fathom_call_id: "share:shared-123",
      meeting_source: "shared_link",
      channel_id: "C123",
      processing_status: "completed",
      digest_enabled: true,
      tracking_enabled: true,
      title: "Shared meeting",
      started_at: new Date("2026-03-24T10:00:00.000Z"),
      ended_at: null,
      duration_seconds: null,
      participants_json: [],
      fathom_summary: "Fallback summary",
      fathom_action_items_json: [],
      fathom_highlights_json: [],
      recording_url: null,
      share_url: "https://fathom.video/share/202",
      transcript_text: null,
      meeting_sentiment: null,
      risk_signals_json: [],
      extraction_status: "not_run",
      digest_posted_at: null,
      digest_claimed_at: null,
      digest_message_ts: null,
      digest_thread_ts: null,
      duplicate_of_meeting_id: null,
      import_mode: "historical",
      last_error: null,
      attempt_count: 0,
      created_at: new Date("2026-03-24T10:00:00.000Z"),
      updated_at: new Date("2026-03-24T10:00:00.000Z"),
    } as never);
    vi.mocked(db.getMeetingByFathomCallId)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        id: "meeting-shared",
        fathom_call_id: "202",
        meeting_source: "api",
        channel_id: "C123",
        processing_status: "completed",
        digest_enabled: true,
        tracking_enabled: true,
        title: "Shared meeting",
        started_at: new Date("2026-03-24T10:00:00.000Z"),
        ended_at: null,
        duration_seconds: null,
        participants_json: [],
        fathom_summary: "Fallback summary",
        fathom_action_items_json: [],
        fathom_highlights_json: [],
        recording_url: null,
        share_url: "https://fathom.video/share/202",
        transcript_text: null,
        meeting_sentiment: null,
        risk_signals_json: [],
        extraction_status: "not_run",
        digest_posted_at: null,
        digest_claimed_at: null,
        digest_message_ts: null,
        digest_thread_ts: null,
        duplicate_of_meeting_id: null,
        import_mode: "historical",
        last_error: null,
        attempt_count: 0,
        created_at: new Date("2026-03-24T10:00:00.000Z"),
        updated_at: new Date("2026-03-24T10:00:00.000Z"),
      } as never);
    vi.mocked(fathomClient.fetchMeetingByCallId).mockResolvedValue({
      title: "Sage weekly sync",
      recordingId: 202,
      shareUrl: "https://fathom.video/share/202",
      url: "https://fathom.video/recording/202",
      recordingStartTime: new Date("2026-03-24T10:00:00.000Z"),
      defaultSummary: {
        markdownFormatted: "Richer API summary.",
      },
    } as never);

    await handleMeetingIngest([makeJob({ importMode: "live" })] as never);

    expect(vi.mocked(db.promoteSharedLinkMeeting)).toHaveBeenCalledWith(
      "workspace-1",
      "meeting-shared",
      {
        fathomCallId: "202",
        meetingSource: "api",
        importMode: "live",
      },
    );
    expect(vi.mocked(db.upsertMeeting)).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSource: "api",
        importMode: "live",
      }),
    );
  });
});
