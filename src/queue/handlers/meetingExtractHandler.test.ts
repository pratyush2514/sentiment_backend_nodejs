import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRow } from "../../types/database.js";

vi.mock("../../config.js", () => ({
  config: {
    LLM_PROVIDER: "openai",
    LLM_MODEL_THREAD: "gpt-4o-mini",
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
  getMeeting: vi.fn(),
  updateMeetingExtractionStatus: vi.fn().mockResolvedValue(undefined),
  updateMeetingExtractionResult: vi.fn().mockResolvedValue(undefined),
  insertMeetingObligations: vi.fn().mockResolvedValue([]),
  insertLLMCost: vi.fn().mockResolvedValue(undefined),
  updateMeetingProcessingStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/meetingExtractor.js", () => ({
  extractMeetingObligations: vi.fn(),
}));

vi.mock("../../services/meetingChannelResolver.js", () => ({
  resolveParticipantsToSlackUsers: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../services/intelligenceTruth.js", () => ({
  recordIntelligenceDegradation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../boss.js", () => ({
  enqueueMeetingDigest: vi.fn().mockResolvedValue("job-digest-1"),
  enqueueMeetingObligationSync: vi.fn().mockResolvedValue("job-sync-1"),
}));

const db = await import("../../db/queries.js");
const extractor = await import("../../services/meetingExtractor.js");
const boss = await import("../boss.js");
const { handleMeetingExtract } = await import("./meetingExtractHandler.js");

function makeMeeting(
  overrides: Partial<MeetingRow> = {},
): MeetingRow {
  return {
    id: "meeting-1",
    workspace_id: "default",
    fathom_call_id: "call-1",
    channel_id: "C123",
    title: "Weekly Client Sync",
    started_at: new Date("2026-03-26T10:00:00.000Z"),
    ended_at: new Date("2026-03-26T10:30:00.000Z"),
    duration_seconds: 1800,
    participants_json: [],
    fathom_summary: "Discussed blocker and next steps.",
    fathom_action_items_json: [],
    fathom_highlights_json: [],
    recording_url: null,
    share_url: null,
    transcript_text: null,
    meeting_sentiment: null,
    risk_signals_json: [],
    processing_status: "extracting",
    extraction_status: "not_run",
    meeting_source: "api",
    digest_posted_at: null,
    digest_claimed_at: null,
    digest_message_ts: null,
    digest_thread_ts: null,
    digest_enabled: true,
    tracking_enabled: true,
    duplicate_of_meeting_id: null,
    import_mode: "live",
    last_error: null,
    attempt_count: 0,
    created_at: new Date("2026-03-26T10:00:00.000Z"),
    updated_at: new Date("2026-03-26T10:00:00.000Z"),
    ...overrides,
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      meetingId: "meeting-1",
      ...overrides,
    },
  };
}

describe("handleMeetingExtract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.updateMeetingExtractionStatus).mockResolvedValue(undefined);
    vi.mocked(db.updateMeetingExtractionResult).mockResolvedValue(undefined);
    vi.mocked(db.insertMeetingObligations).mockResolvedValue([] as never);
    vi.mocked(db.insertLLMCost).mockResolvedValue(undefined);
    vi.mocked(db.updateMeetingProcessingStatus).mockResolvedValue(undefined);
    vi.mocked(extractor.extractMeetingObligations).mockResolvedValue({
      result: {
        obligations: [
          {
            type: "action_item",
            title: "Send updated timeline",
            description: "Share the revised timeline with the client.",
            ownerName: "Sidd",
            dueDate: null,
            priority: "high",
            confidence: 0.92,
            sourceContext: "We should send the updated timeline today.",
          },
        ],
        meetingSentiment: "concerned",
        riskSignals: ["Timeline risk remains open."],
      },
      raw: {
        content: "{}",
        promptTokens: 100,
        completionTokens: 50,
      },
    } as never);
    vi.mocked(boss.enqueueMeetingDigest).mockResolvedValue("job-digest-1");
    vi.mocked(boss.enqueueMeetingObligationSync).mockResolvedValue("job-sync-1");
  });

  it("suppresses digest and follow-up side effects for historical meetings", async () => {
    vi.mocked(db.getMeeting).mockResolvedValue(
      makeMeeting({
        import_mode: "historical",
      }) as never,
    );

    await handleMeetingExtract([makeJob()] as never);

    expect(vi.mocked(db.updateMeetingExtractionResult)).toHaveBeenCalledWith(
      "default",
      "meeting-1",
      expect.objectContaining({
        extractionStatus: "completed",
        processingStatus: "completed",
      }),
    );
    expect(vi.mocked(boss.enqueueMeetingDigest)).not.toHaveBeenCalled();
    expect(vi.mocked(boss.enqueueMeetingObligationSync)).not.toHaveBeenCalled();
  });

  it("keeps live meeting digest behavior unchanged", async () => {
    vi.mocked(db.getMeeting).mockResolvedValue(makeMeeting() as never);

    await handleMeetingExtract([makeJob()] as never);

    expect(vi.mocked(boss.enqueueMeetingDigest)).toHaveBeenCalledWith({
      workspaceId: "default",
      meetingId: "meeting-1",
      channelId: "C123",
    });
  });
});
