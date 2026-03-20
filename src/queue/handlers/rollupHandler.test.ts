import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    LLM_DAILY_BUDGET_USD: 10.0,
    EMBEDDING_MODEL: "text-embedding-3-small",
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
  getDailyLLMCost: vi.fn().mockResolvedValue(0),
  getLatestContextDocument: vi.fn().mockResolvedValue(null),
  getEffectiveAnalysisWindowDays: vi.fn().mockResolvedValue(7),
  getMessagesSinceTs: vi.fn().mockResolvedValue([]),
  getMessagesInWindow: vi.fn().mockResolvedValue([]),
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
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  getChannelHealthCounts: vi.fn().mockResolvedValue([
    {
      channel_id: "C123",
      analysis_window_days: 7,
      open_alert_count: "0",
      high_severity_alert_count: "0",
      automation_incident_count: "0",
      critical_automation_incident_count: "0",
      automation_incident_24h_count: "0",
      critical_automation_incident_24h_count: "0",
      human_risk_signal_count: "0",
      request_signal_count: "0",
      decision_signal_count: "0",
      resolution_signal_count: "0",
      flagged_message_count: "0",
      high_risk_message_count: "0",
      attention_thread_count: "0",
      blocked_thread_count: "0",
      escalated_thread_count: "0",
      risky_thread_count: "0",
      total_message_count: "0",
      skipped_message_count: "0",
      context_only_message_count: "0",
      ignored_message_count: "0",
      inflight_message_count: "0",
      total_analyzed_count: "0",
      anger_count: "0",
      joy_count: "0",
      sadness_count: "0",
      neutral_count: "0",
      fear_count: "0",
      surprise_count: "0",
      disgust_count: "0",
    },
  ]),
  getUserProfiles: vi.fn().mockResolvedValue([]),
  getChannelState: vi.fn().mockResolvedValue(null),
  getMessagesEnriched: vi.fn().mockResolvedValue([]),
  getMessageCount: vi.fn().mockResolvedValue(0),
  getRelatedIncidentMentions: vi.fn().mockResolvedValue([]),
  insertContextDocument: vi.fn(),
  upsertChannelState: vi.fn(),
  upsertThreadInsight: vi.fn(),
  resetRollupState: vi.fn(),
  insertLLMCost: vi.fn(),
}));

vi.mock("../../services/summarizer.js", () => ({
  channelRollup: vi.fn(),
  threadRollup: vi.fn(),
  backfillSummarize: vi.fn(),
  estimateTokens: vi.fn().mockReturnValue(50),
}));

vi.mock("../../services/embeddingProvider.js", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
}));

vi.mock("../../services/costEstimator.js", () => ({
  estimateCost: vi.fn().mockReturnValue(0.001),
}));

const db = await import("../../db/queries.js");
const { channelRollup, threadRollup } = await import("../../services/summarizer.js");
const { createEmbeddingProvider } = await import("../../services/embeddingProvider.js");
const { handleSummaryRollup } = await import("./rollupHandler.js");

function recentTs(offsetSeconds = 0): string {
  return String(Date.now() / 1000 - offsetSeconds);
}

function makeFreshSummaryDoc() {
  return {
    source_ts_start: recentTs(60),
    source_ts_end: recentTs(30),
    created_at: new Date(),
    message_count: 3,
  };
}

function makeJob(rollupType: string, overrides = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      channelId: "C123",
      rollupType,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getDailyLLMCost).mockResolvedValue(0);
  vi.mocked(db.getEffectiveAnalysisWindowDays).mockResolvedValue(7);
  vi.mocked(db.getLatestContextDocument).mockResolvedValue(makeFreshSummaryDoc() as never);
  vi.mocked(db.getMessagesInWindow).mockResolvedValue([]);
  vi.mocked(db.getChannel).mockResolvedValue({
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
  } as never);
  vi.mocked(db.getFollowUpRule).mockResolvedValue(null);
  vi.mocked(db.getChannelHealthCounts).mockResolvedValue([
    {
      channel_id: "C123",
      analysis_window_days: 7,
      open_alert_count: "0",
      high_severity_alert_count: "0",
      automation_incident_count: "0",
      critical_automation_incident_count: "0",
      automation_incident_24h_count: "0",
      critical_automation_incident_24h_count: "0",
      human_risk_signal_count: "0",
      request_signal_count: "0",
      decision_signal_count: "0",
      resolution_signal_count: "0",
      flagged_message_count: "0",
      high_risk_message_count: "0",
      attention_thread_count: "0",
      blocked_thread_count: "0",
      escalated_thread_count: "0",
      risky_thread_count: "0",
      total_message_count: "0",
      skipped_message_count: "0",
      context_only_message_count: "0",
      ignored_message_count: "0",
      inflight_message_count: "0",
      total_analyzed_count: "0",
      anger_count: "0",
      joy_count: "0",
      sadness_count: "0",
      neutral_count: "0",
      fear_count: "0",
      surprise_count: "0",
      disgust_count: "0",
    },
  ] as never);
  vi.mocked(db.getRelatedIncidentMentions).mockResolvedValue([] as never);
  vi.mocked(createEmbeddingProvider).mockReturnValue(null);
});

describe("handleSummaryRollup", () => {
  it("skips when budget exceeded", async () => {
    vi.mocked(db.getDailyLLMCost).mockResolvedValue(15.0);
    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).not.toHaveBeenCalled();
  });

  it("handles channel rollup: stores doc, updates state, resets counter", async () => {
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
      { ts: "1.2", user_id: "U2", text: "world", normalized_text: "world" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "old summary",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue({
      summary: "Updated summary of discussion",
      keyDecisions: ["decision1"],
      tokenCount: 100,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 200, completionTokens: 100 },
    });

    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        docType: "channel_rollup",
        content: "Updated summary of discussion",
      }),
    );
    expect(db.upsertChannelState).toHaveBeenCalledWith(
      "default", "C123",
      expect.objectContaining({
        running_summary: "Updated summary of discussion",
        key_decisions_json: ["decision1"],
      }),
    );
    expect(db.resetRollupState).toHaveBeenCalled();
    expect(db.insertLLMCost).toHaveBeenCalled();
  });

  it("handles thread rollup: stores doc with thread metadata", async () => {
    const ts = recentTs(10);
    vi.mocked(db.getMessagesEnriched).mockResolvedValue([
      { ts, user_id: "U1", text: "thread msg", normalized_text: "thread msg", display_name: null, real_name: "Alice" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "channel context",
    } as never);
    vi.mocked(threadRollup).mockResolvedValue({
      summary: "Thread about feature X",
      keyDecisions: [],
      primaryIssue: "Feature X is blocked on a dependency.",
      threadState: "blocked",
      emotionalTemperature: "watch",
      operationalRisk: "medium",
      surfacePriority: "medium",
      crucialMoments: [
        {
          messageTs: ts,
          kind: "issue_opened",
          reason: "Thread root introduced the issue.",
          surfacePriority: "medium",
        },
      ],
      openQuestions: [],
      tokenCount: 50,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    });

    await handleSummaryRollup([makeJob("thread", { threadTs: "1.0" })] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        docType: "thread_rollup",
        sourceThreadTs: "1.0",
      }),
    );
  });

  it("throws when channel rollup generation fails so pg-boss can retry", async () => {
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue(null);

    await expect(handleSummaryRollup([makeJob("channel")] as never)).rejects.toThrow(
      "Channel rollup failed for C123",
    );
  });

  it("stores doc without embedding when embedding fails", async () => {
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue({
      summary: "Summary",
      keyDecisions: [],
      tokenCount: 50,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    });
    // Embedding provider exists but throws
    vi.mocked(createEmbeddingProvider).mockReturnValue({
      embed: vi.fn().mockRejectedValue(new Error("API error")),
      embedBatch: vi.fn(),
    } as never);

    await handleSummaryRollup([makeJob("channel")] as never);

    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null }),
    );
  });

  it("continues processing later jobs when an earlier rollup is skipped", async () => {
    vi.mocked(db.getDailyLLMCost)
      .mockResolvedValueOnce(15.0)
      .mockResolvedValueOnce(0);
    vi.mocked(db.getMessagesSinceTs).mockResolvedValue([
      { ts: "1.1", user_id: "U1", text: "hello", normalized_text: "hello" },
    ] as never);
    vi.mocked(db.getChannelState).mockResolvedValue({
      running_summary: "",
      key_decisions_json: [],
    } as never);
    vi.mocked(channelRollup).mockResolvedValue({
      summary: "Summary",
      keyDecisions: [],
      tokenCount: 50,
      raw: { content: "", model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50 },
    });

    await handleSummaryRollup([
      makeJob("channel", { channelId: "C123" }),
      makeJob("channel", { channelId: "C456" }),
    ] as never);

    expect(db.insertContextDocument).toHaveBeenCalledTimes(1);
    expect(db.insertContextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C456",
      }),
    );
  });
});
