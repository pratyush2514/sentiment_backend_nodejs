import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageTriageResult } from "../../services/messageTriage.js";
import type {
  ChannelStateRow,
  FollowUpRuleRow,
} from "../../types/database.js";

function makeChannel(
  status: "pending" | "ready" = "ready",
  name = "sage_team",
) {
  return {
    id: "channel-1",
    workspace_id: "default",
    channel_id: "C123",
    name,
    conversation_type: "public_channel" as const,
    status,
    initialized_at: new Date(),
    last_event_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

vi.mock("../../config.js", () => ({
  config: {
    ROLLUP_MSG_THRESHOLD: 20,
    ROLLUP_TIME_THRESHOLD_MIN: 10,
    ROLLUP_THREAD_REPLY_THRESHOLD: 10,
    THREAD_HOT_REPLY_THRESHOLD: 5,
    THREAD_HOT_WINDOW_MIN: 3,
    LLM_COOLDOWN_SEC: 60,
    LOW_SIGNAL_CHANNEL_NAMES: ["general", "random", "social", "watercooler"],
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
  upsertMessage: vi.fn(),
  upsertMessageTriage: vi.fn(),
  upsertThreadEdge: vi.fn(),
  updateChannelLastEvent: vi.fn(),
  incrementMessageCounters: vi.fn(),
  updateNormalizedText: vi.fn(),
  updateMessageAnalysisStatus: vi.fn(),
  getChannel: vi.fn().mockResolvedValue(makeChannel()),
  getChannelState: vi.fn(),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  resetLLMGatingState: vi.fn(),
  getThreadReplyCount: vi.fn().mockResolvedValue(0),
  getRecentThreadReplyCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../services/userProfiles.js", () => ({
  resolveUserProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/textNormalizer.js", () => ({
  normalizeText: vi.fn((text: string) => text),
  buildFileContext: vi.fn(() => ""),
  buildLinkContext: vi.fn(() => ""),
  extractLinks: vi.fn(() => []),
}));

vi.mock("../../services/followUpMonitor.js", () => ({
  processFollowUpsForMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/canonicalChannelState.js", () => ({
  persistCanonicalChannelState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/eventBus.js", () => ({
  eventBus: {
    createAndPublish: vi.fn(),
  },
}));

vi.mock("../../services/llmGate.js", () => ({
  evaluateLLMGate: vi.fn().mockReturnValue(null),
}));

vi.mock("../../services/messageTriage.js", () => ({
  classifyMessageTriage: vi.fn().mockReturnValue(makeTriageResult()),
  isDeepAnalysisCandidate: vi.fn((kind: string | null | undefined) => kind === "message_candidate"),
  shouldEnrichMessageSignal: vi.fn((
    triage: { candidateKind?: string | null } | null | undefined,
  ) => triage?.candidateKind === "message_candidate"),
  shouldRefreshThreadInsight: vi.fn((
    triage:
      | { candidateKind?: string; surfacePriority?: string; stateTransition?: string | null }
      | null
      | undefined,
    threadTs?: string | null,
  ) =>
    Boolean(
      threadTs &&
        (
          triage?.candidateKind === "thread_turning_point" ||
          triage?.candidateKind === "resolution_signal" ||
          (
            triage?.candidateKind === "message_candidate" &&
            (
              triage?.surfacePriority === "high" ||
              triage?.stateTransition === "blocked" ||
              triage?.stateTransition === "waiting_external" ||
              triage?.stateTransition === "escalated"
            )
          )
        ),
    ),
  ),
}));

vi.mock("../boss.js", () => ({
  enqueueRealtimeLLMAnalyze: vi.fn().mockResolvedValue("job-llm-1"),
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-1"),
}));

const db = await import("../../db/queries.js");
const boss = await import("../boss.js");
const { evaluateLLMGate } = await import("../../services/llmGate.js");
const { classifyMessageTriage } = await import("../../services/messageTriage.js");
const { handleMessageIngest } = await import("./messageHandler.js");

function makeChannelState(
  overrides: Partial<ChannelStateRow> = {},
): ChannelStateRow {
  return {
    id: "cs-1",
    workspace_id: "default",
    channel_id: "C123",
    running_summary: "",
    participants_json: {},
    active_threads_json: [],
    key_decisions_json: [],
    signal: "stable",
    health: "healthy",
    signal_confidence: 0.5,
    risk_drivers_json: [],
    attention_summary_json: {
      status: "clear",
      title: "No active attention",
      message: "Nothing needs attention right now.",
      driverKeys: [],
    },
    message_disposition_counts_json: {
      totalInWindow: 0,
      deepAiAnalyzed: 0,
      heuristicIncidentSignals: 0,
      contextOnly: 0,
      routineAcknowledgments: 0,
      storedWithoutDeepAnalysis: 0,
      inFlight: 0,
    },
    effective_channel_mode: "collaboration",
    sentiment_snapshot_json: { totalMessages: 0, highRiskCount: 0, updatedAt: "" },
    messages_since_last_llm: 0,
    last_llm_run_at: null,
    llm_cooldown_until: null,
    last_reconcile_at: null,
    messages_since_last_rollup: 0,
    last_rollup_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTriageResult(
  overrides: Partial<MessageTriageResult> = {},
): MessageTriageResult {
  return {
    candidateKind: "message_candidate",
    surfacePriority: "medium",
    candidateScore: 0.7,
    stateTransition: "issue_opened",
    signalType: "request",
    severity: "medium",
    stateImpact: "issue_opened",
    evidenceType: "heuristic",
    channelMode: "collaboration",
    originType: "human",
    confidence: 0.78,
    incidentFamily: "none",
    reasonCodes: ["question"],
    signals: {},
    ...overrides,
  };
}

function makeFollowUpRule(
  overrides: Partial<FollowUpRuleRow> = {},
): FollowUpRuleRow {
  return {
    id: "rule-1",
    workspace_id: "default",
    channel_id: "C123",
    conversation_type: "public_channel",
    enabled: true,
    sla_hours: 24,
    analysis_window_days: 7,
    owner_user_ids: [],
    client_user_ids: [],
    senior_user_ids: [],
    importance_tier_override: "auto",
    channel_mode_override: "auto",
    slack_notifications_enabled: false,
    muted: false,
    privacy_opt_in: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return {
    id: "job-1",
    data: {
      workspaceId: "default",
      channelId: "C123",
      ts: "1.1",
      userId: "U1",
      text: "hello world",
      threadTs: null,
      eventId: "ev-1",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.upsertMessage).mockResolvedValue({
    id: "m-1",
    workspace_id: "default",
    channel_id: "C123",
    ts: "1.1",
    thread_ts: null,
    user_id: "U1",
    text: "hello world",
    normalized_text: null,
    subtype: null,
    bot_id: null,
    source: "realtime",
    analysis_status: "pending",
    files_json: null,
    links_json: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  vi.mocked(db.getChannelState).mockResolvedValue({
    ...makeChannelState(),
  });
  vi.mocked(evaluateLLMGate).mockReturnValue(null);
  vi.mocked(classifyMessageTriage).mockReturnValue(makeTriageResult());
  vi.mocked(db.getFollowUpRule).mockResolvedValue(null);
  vi.mocked(db.getThreadReplyCount).mockResolvedValue(0);
  vi.mocked(db.getRecentThreadReplyCount).mockResolvedValue(0);
});

describe("handleMessageIngest", () => {
  it("stores message and increments counters", async () => {
    await handleMessageIngest([makeJob()] as never);

    expect(db.upsertMessage).toHaveBeenCalledWith(
      "default", "C123", "1.1", "U1", "hello world", "realtime", null, null, null, null, null,
    );
    expect(db.upsertMessageTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTs: "1.1",
        candidateKind: "message_candidate",
      }),
    );
    expect(db.incrementMessageCounters).toHaveBeenCalled();
  });

  it("skips realtime analysis when the gate does not fire", async () => {
    vi.mocked(evaluateLLMGate).mockReturnValue(null);

    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueRealtimeLLMAnalyze).not.toHaveBeenCalled();
    expect(db.resetLLMGatingState).not.toHaveBeenCalled();
    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default",
      "C123",
      "1.1",
      "skipped",
    );
  });

  it("creates thread edge for threaded replies", async () => {
    await handleMessageIngest([makeJob({ threadTs: "1.0", ts: "1.1" })] as never);

    expect(db.upsertThreadEdge).toHaveBeenCalledWith("default", "C123", "1.0", "1.1");
  });

  it("triggers LLM analysis when gate fires", async () => {
    vi.mocked(evaluateLLMGate).mockReturnValue("threshold");
    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueRealtimeLLMAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        triggerType: "threshold",
      }),
    );
  });

  it("refreshes thread insight without deep message analysis for turning-point messages", async () => {
    vi.mocked(evaluateLLMGate).mockReturnValue("threshold");
    vi.mocked(classifyMessageTriage).mockReturnValue(
      makeTriageResult({
        candidateKind: "thread_turning_point",
        candidateScore: 0.56,
        stateTransition: "investigating",
        signalType: "decision",
        stateImpact: "investigating",
        confidence: 0.7,
        reasonCodes: ["decision_signal"],
      }),
    );

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueRealtimeLLMAnalyze).not.toHaveBeenCalled();
    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "thread", threadTs: "1.0" }),
    );
  });

  it("triggers channel rollup when threshold exceeded", async () => {
    vi.mocked(db.getChannelState).mockResolvedValue(
      makeChannelState({ messages_since_last_rollup: 20 }),
    );

    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "channel" }),
    );
  });

  it("triggers thread rollup when reply count exceeds threshold", async () => {
    vi.mocked(db.getThreadReplyCount).mockResolvedValue(10);

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "thread", threadTs: "1.0" }),
    );
  });

  it("triggers thread rollup for hot threads even before the total reply threshold", async () => {
    vi.mocked(db.getRecentThreadReplyCount).mockResolvedValue(5);

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "thread", threadTs: "1.0" }),
    );
  });

  it("updates channel recency even when the channel is still setting up", async () => {
    vi.mocked(db.getChannel).mockResolvedValue(makeChannel("pending"));

    await handleMessageIngest([makeJob()] as never);

    expect(db.updateChannelLastEvent).toHaveBeenCalledWith("default", "C123");
    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default",
      "C123",
      "1.1",
      "skipped",
    );
    expect(db.incrementMessageCounters).not.toHaveBeenCalled();
  });

  it("suppresses routine message analysis in low-value channels", async () => {
    vi.mocked(db.getChannel).mockResolvedValue(makeChannel("ready", "general"));
    vi.mocked(evaluateLLMGate).mockReturnValue("threshold");

    await handleMessageIngest([makeJob()] as never);

    expect(boss.enqueueRealtimeLLMAnalyze).not.toHaveBeenCalled();
  });

  it("suppresses momentum thread rollups in low-value channels", async () => {
    vi.mocked(db.getChannel).mockResolvedValue(makeChannel("ready", "general"));
    vi.mocked(db.getThreadReplyCount).mockResolvedValue(10);
    vi.mocked(db.getRecentThreadReplyCount).mockResolvedValue(5);

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueSummaryRollup).not.toHaveBeenCalled();
  });

  it("uses faster thread rollup thresholds for high-value channels", async () => {
    vi.mocked(db.getFollowUpRule).mockResolvedValue(
      makeFollowUpRule({
        client_user_ids: ["U-client"],
        slack_notifications_enabled: true,
        privacy_opt_in: true,
      }),
    );
    vi.mocked(db.getThreadReplyCount).mockResolvedValue(8);

    await handleMessageIngest([makeJob({ threadTs: "1.0" })] as never);

    expect(boss.enqueueSummaryRollup).toHaveBeenCalledWith(
      expect.objectContaining({ rollupType: "thread", threadTs: "1.0" }),
    );
  });
});
