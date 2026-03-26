/**
 * E2E Flow Test: Message ingest → LLM gate → analysis → analytics visible
 *
 * Mocks external boundaries (DB, Slack API, LLM providers) but wires together
 * the real handler logic to verify the full pipeline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock external boundaries ───────────────────────────────────────────────

vi.mock("../../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-4o-mini",
    LLM_DAILY_BUDGET_USD: 10.0,
    LLM_MSG_THRESHOLD: 20,
    LLM_TIME_THRESHOLD_MIN: 10,
    LLM_COOLDOWN_SEC: 60,
    LLM_RISK_THRESHOLD: 0.7,
    ROLLUP_MSG_THRESHOLD: 20,
    ROLLUP_TIME_THRESHOLD_MIN: 10,
    ROLLUP_THREAD_REPLY_THRESHOLD: 10,
    CONTEXT_TOKEN_BUDGET: 3500,
    EMBEDDING_MODEL: "text-embedding-3-small",
    LOW_SIGNAL_CHANNEL_NAMES: [],
    NODE_ENV: "test",
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Track calls to verify the pipeline
const storedAnalytics: Record<string, unknown>[] = [];
const storedCosts: Record<string, unknown>[] = [];
const recentMessageTs = `${Math.floor(Date.now() / 1000)}.100000`;

function makeChannelState(overrides = {}) {
  return {
    id: "cs-1",
    workspace_id: "default",
    channel_id: "C_E2E",
    running_summary: "Team discussing project timeline",
    participants_json: {},
    active_threads_json: [],
    key_decisions_json: ["Use React for frontend"],
    signal: "elevated",
    health: "attention",
    signal_confidence: 0.72,
    risk_drivers_json: [],
    attention_summary_json: {
      status: "watch",
      title: "Worth reviewing",
      message: "Recent pressure is building in this channel.",
      driverKeys: [],
    },
    message_disposition_counts_json: {
      totalInWindow: 50,
      deepAiAnalyzed: 45,
      heuristicIncidentSignals: 0,
      contextOnly: 0,
      routineAcknowledgments: 0,
      storedWithoutDeepAnalysis: 0,
      inFlight: 0,
    },
    effective_channel_mode: "collaboration",
    sentiment_snapshot_json: { totalMessages: 50, highRiskCount: 1, updatedAt: "" },
    messages_since_last_llm: 5,
    last_llm_run_at: new Date(Date.now() - 120_000),
    llm_cooldown_until: null,
    last_reconcile_at: null,
    messages_since_last_rollup: 3,
    last_rollup_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

vi.mock("../../src/db/queries.js", () => ({
  upsertMessage: vi.fn().mockResolvedValue({ analysis_status: "pending" }),
  upsertMessageTriage: vi.fn(),
  upsertThreadEdge: vi.fn(),
  updateChannelLastEvent: vi.fn(),
  incrementMessageCounters: vi.fn(),
  updateNormalizedText: vi.fn(),
  getChannel: vi.fn().mockResolvedValue({ status: "ready" }),
  getChannelClassification: vi.fn().mockResolvedValue(null),
  getChannelState: vi.fn().mockResolvedValue(makeChannelState()),
  getChannelHealthCounts: vi.fn().mockResolvedValue([
    {
      channel_id: "C_E2E",
      analysis_window_days: 7,
      open_alert_count: "0",
      high_severity_alert_count: "0",
      automation_incident_count: "0",
      critical_automation_incident_count: "0",
      automation_incident_24h_count: "0",
      critical_automation_incident_24h_count: "0",
      human_risk_signal_count: "1",
      request_signal_count: "0",
      decision_signal_count: "0",
      resolution_signal_count: "0",
      flagged_message_count: "1",
      high_risk_message_count: "1",
      attention_thread_count: "0",
      blocked_thread_count: "0",
      escalated_thread_count: "0",
      risky_thread_count: "0",
      total_message_count: "50",
      skipped_message_count: "0",
      context_only_message_count: "0",
      ignored_message_count: "0",
      inflight_message_count: "0",
      total_analyzed_count: "45",
      anger_count: "1",
      joy_count: "0",
      sadness_count: "0",
      neutral_count: "44",
      fear_count: "0",
      surprise_count: "0",
      disgust_count: "0",
    },
  ]),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  resetLLMGatingState: vi.fn(),
  getThreadReplyCount: vi.fn().mockResolvedValue(0),
  getDailyLLMCost: vi.fn().mockResolvedValue(0.5),
  getMessages: vi.fn().mockResolvedValue([
    {
      id: "m-1", workspace_id: "default", channel_id: "C_E2E",
      ts: recentMessageTs, thread_ts: null, user_id: "U_SENDER",
      text: "This deadline is ridiculous, we can't possibly deliver on time",
      normalized_text: "This deadline is ridiculous, we can't possibly deliver on time",
      subtype: null, bot_id: null, source: "realtime",
      analysis_status: "pending", created_at: new Date(), updated_at: new Date(),
    },
  ]),
  upsertMessageIntelligenceState: vi.fn().mockResolvedValue(undefined),
  updateMessageAnalysisStatus: vi.fn(),
  insertMessageAnalytics: vi.fn((data) => storedAnalytics.push(data)),
  insertLLMCost: vi.fn((data) => storedCosts.push(data)),
  upsertChannelState: vi.fn(),
  searchContextDocuments: vi.fn().mockResolvedValue([]),
  getMessagesEnrichedByTs: vi.fn().mockResolvedValue([
    {
      id: "m-1", workspace_id: "default", channel_id: "C_E2E",
      ts: recentMessageTs, thread_ts: null, user_id: "U_SENDER",
      text: "This deadline is ridiculous, we can't possibly deliver on time",
      normalized_text: "This deadline is ridiculous, we can't possibly deliver on time",
      subtype: null, bot_id: null, source: "realtime",
      analysis_status: "pending", created_at: new Date(), updated_at: new Date(),
      ma_dominant_emotion: null,
      mt_candidate_kind: "message_candidate",
    },
  ]),
}));

vi.mock("../../src/services/userProfiles.js", () => ({
  resolveUserProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/services/followUpMonitor.js", () => ({
  processFollowUpsForMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/eventBus.js", () => ({
  eventBus: {
    createAndPublish: vi.fn(),
  },
}));

vi.mock("../../src/services/textNormalizer.js", () => ({
  normalizeText: vi.fn((t: string) => t),
  buildFileContext: vi.fn(() => ""),
  buildLinkContext: vi.fn(() => ""),
  extractLinks: vi.fn(() => []),
}));

vi.mock("../../src/services/llmGate.js", () => ({
  evaluateLLMGate: vi.fn().mockReturnValue("risk"),
}));

vi.mock("../../src/queue/boss.js", () => ({
  enqueueLLMAnalyze: vi.fn().mockResolvedValue("job-llm-e2e"),
  enqueueRealtimeLLMAnalyze: vi.fn().mockResolvedValue("job-realtime-e2e"),
  enqueueSummaryRollup: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/services/emotionAnalyzer.js", () => ({
  analyzeMessage: vi.fn().mockResolvedValue({
    status: "success",
    data: {
      dominant_emotion: "anger",
      confidence: 0.88,
      escalation_risk: "high",
      sarcasm_detected: false,
      explanation: "Frustration about unrealistic deadline",
    },
    raw: { model: "gpt-4o-mini", promptTokens: 450, completionTokens: 80 },
  }),
  analyzeThread: vi.fn(),
}));

vi.mock("../../src/services/alerting.js", () => ({
  checkAndAlert: vi.fn(),
  alertBudgetExceeded: vi.fn(),
  sendSentimentAlertDMs: vi.fn(),
}));

vi.mock("../../src/services/riskHeuristic.js", () => ({
  computeRiskScore: vi.fn().mockReturnValue(0.8),
}));

vi.mock("../../src/services/costEstimator.js", () => ({
  estimateCost: vi.fn().mockReturnValue(0.0003),
}));

vi.mock("../../src/services/contextAssembler.js", () => ({
  assembleContext: vi.fn().mockResolvedValue({
    runningSummary: "Team discussing project timeline",
    keyDecisions: ["Use React for frontend"],
    relevantDocuments: [],
    recentMessages: [],
    totalTokens: 200,
  }),
}));

vi.mock("../../src/services/embeddingProvider.js", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
}));

// ─── Import handlers ────────────────────────────────────────────────────────

const db = await import("../../src/db/queries.js");
const boss = await import("../../src/queue/boss.js");
const { checkAndAlert } = await import("../../src/services/alerting.js");
const { handleMessageIngest } = await import("../../src/queue/handlers/messageHandler.js");
const { handleLLMAnalyze } = await import("../../src/queue/handlers/analyzeHandler.js");

beforeEach(() => {
  storedAnalytics.length = 0;
  storedCosts.length = 0;
});

describe("E2E: Message → Analysis → Analytics", () => {
  it("full pipeline: high-risk message triggers analysis and stores results", async () => {
    // Step 1: Message ingest
    await handleMessageIngest([{
      id: "ingest-job-1",
      data: {
        workspaceId: "default",
        channelId: "C_E2E",
        ts: recentMessageTs,
        userId: "U_SENDER",
        text: "This deadline is ridiculous, we can't possibly deliver on time",
        threadTs: null,
        eventId: "ev-e2e-1",
      },
    }] as never);

    // Verify message was stored
    expect(db.upsertMessage).toHaveBeenCalledWith(
      "default", "C_E2E", recentMessageTs, "U_SENDER",
      "This deadline is ridiculous, we can't possibly deliver on time",
      "realtime", null, null, null, null, null,
    );

    // Verify counters incremented
    expect(db.incrementMessageCounters).toHaveBeenCalled();

    // Verify realtime LLM analysis was enqueued
    expect(boss.enqueueRealtimeLLMAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        channelId: "C_E2E",
      }),
    );

    // Step 2: LLM analysis (simulating pg-boss picking up the job)
    await handleLLMAnalyze([{
      id: "analyze-job-1",
      data: {
        workspaceId: "default",
        channelId: "C_E2E",
        triggerType: "risk",
        threadTs: null,
      },
    }] as never);

    // Verify analytics were stored with correct emotion
    expect(storedAnalytics).toHaveLength(1);
    expect(storedAnalytics[0]).toMatchObject({
      workspaceId: "default",
      channelId: "C_E2E",
      messageTs: recentMessageTs,
      dominantEmotion: "anger",
      confidence: 0.88,
      escalationRisk: "high",
    });

    // Verify LLM cost was recorded
    expect(storedCosts).toHaveLength(1);
    expect(storedCosts[0]).toMatchObject({
      llmModel: "gpt-4o-mini",
      jobType: "llm.analyze",
    });

    // Verify alert was triggered for high-risk message
    expect(checkAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({ escalation_risk: "high" }),
      expect.objectContaining({ workspaceId: "default", channelId: "C_E2E" }),
    );

    // Verify message marked as completed
    expect(db.updateMessageAnalysisStatus).toHaveBeenCalledWith(
      "default", "C_E2E", recentMessageTs, "completed",
    );

    // Verify sentiment snapshot updated
    expect(db.upsertChannelState).toHaveBeenCalledWith(
      "default", "C_E2E",
      expect.objectContaining({
        sentiment_snapshot_json: expect.objectContaining({
          highRiskCount: 2, // was 1, now +1
        }),
      }),
    );
  });
});
