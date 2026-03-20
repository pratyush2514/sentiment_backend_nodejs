import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChannelHealthCountsRow,
  ChannelStateRow,
} from "../types/database.js";

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "test",
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
      success: vi.fn(),
    }),
  },
}));

vi.mock("../db/queries.js", () => ({
  getAllChannelsWithState: vi.fn(),
  getChannelSentimentSparklines: vi.fn().mockResolvedValue([]),
  getChannel: vi.fn(),
  getChannelState: vi.fn(),
  listConversationPolicies: vi.fn().mockResolvedValue([]),
  getMessageCount: vi.fn(),
  getChannelParticipantCounts: vi.fn(),
  getChannelHealthCounts: vi.fn().mockResolvedValue([]),
  getRelatedIncidentMentions: vi.fn().mockResolvedValue([]),
  getThreads: vi.fn(),
  getThreadInsightsBatch: vi.fn().mockResolvedValue([]),
  getThreadInsight: vi.fn().mockResolvedValue(null),
  getUserProfiles: vi.fn(),
  getRoleAssignmentsForUsers: vi.fn().mockResolvedValue([]),
  getUserSentimentSummaries: vi.fn().mockResolvedValue([]),
  getRecentParticipantSignals: vi.fn().mockResolvedValue([]),
  getMessagesEnriched: vi.fn(),
  getMessagesByTs: vi.fn(),
  getMessagesEnrichedByTs: vi.fn(),
  getTopLevelMessagesEnriched: vi.fn(),
  getThreadRepliesEnriched: vi.fn(),
  getActiveThreads: vi.fn(),
  getMessageAnalytics: vi.fn(),
  getEffectiveAnalysisWindowDays: vi.fn().mockResolvedValue(7),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  upsertChannel: vi.fn(),
  getChannelSummary: vi.fn(),
  getUnresolvedMessageTs: vi.fn().mockResolvedValue(["1710000000.000100"]),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueBackfill: vi.fn().mockResolvedValue("job-backfill-1"),
  enqueueLLMAnalyze: vi.fn().mockResolvedValue("job-analyze-1"),
  enqueueLLMAnalyzeBatches: vi.fn().mockResolvedValue(["job-analyze-1"]),
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-1"),
}));

vi.mock("../services/channelMetadata.js", () => ({
  resolveChannelMetadata: vi.fn(),
}));

vi.mock("../services/canonicalMessageSignals.js", () => ({
  hydrateChannelCanonicalSignals: vi.fn().mockResolvedValue({
    hydratedCount: 0,
    inspectedCount: 0,
  }),
  reclassifyChannelCanonicalSignals: vi.fn().mockResolvedValue({
    reclassifiedCount: 0,
    inspectedCount: 0,
  }),
  shouldRepairMissingCanonicalSignals: vi.fn().mockReturnValue(false),
}));

vi.mock("../services/canonicalChannelState.js", () => ({
  persistCanonicalChannelState: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("../db/queries.js");
const _boss = await import("../queue/boss.js");
const channelMetadata = await import("../services/channelMetadata.js");
const canonicalMessageSignals = await import("../services/canonicalMessageSignals.js");
const canonicalChannelState = await import("../services/canonicalChannelState.js");
const { channelsRouter } = await import("./channels.js");

function makeChannelState(
  overrides: Partial<ChannelStateRow> = {},
): ChannelStateRow {
  return {
    id: "uuid-2",
    workspace_id: "default",
    channel_id: "C123ABC",
    running_summary: "Test summary",
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

function makeHealthCounts(
  overrides: Partial<ChannelHealthCountsRow> = {},
): ChannelHealthCountsRow {
  return {
    channel_id: "C123ABC",
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
    ...overrides,
  };
}

function forceLocalhostListen(app: express.Express) {
  const originalListen = app.listen.bind(app);
  app.listen = ((...args: unknown[]) => {
    if (typeof args[0] === "number" && args.length === 1) {
      return originalListen(args[0], "127.0.0.1");
    }
    if (typeof args[0] === "number" && typeof args[1] === "function") {
      return originalListen(args[0], "127.0.0.1", args[1] as () => void);
    }
    return originalListen(...(args as Parameters<typeof originalListen>));
  }) as typeof app.listen;
  return app;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = "test-req-id";
    next();
  });
  app.use("/api/channels", channelsRouter);
  return forceLocalhostListen(app);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannelHealthCounts).mockResolvedValue([]);
  vi.mocked(db.getChannelSentimentSparklines).mockResolvedValue([] as never);
  vi.mocked(db.getEffectiveAnalysisWindowDays).mockResolvedValue(7);
  vi.mocked(db.getUnresolvedMessageTs).mockResolvedValue(["1710000000.000100"]);
  vi.mocked(db.getFollowUpRule).mockResolvedValue(null);
  vi.mocked(db.getRelatedIncidentMentions).mockResolvedValue([] as never);
  vi.mocked(db.listConversationPolicies).mockResolvedValue([]);
  vi.mocked(canonicalMessageSignals.hydrateChannelCanonicalSignals).mockResolvedValue({
    hydratedCount: 0,
    inspectedCount: 0,
  } as never);
  vi.mocked(canonicalMessageSignals.reclassifyChannelCanonicalSignals).mockResolvedValue({
    reclassifiedCount: 0,
    inspectedCount: 0,
  } as never);
  vi.mocked(canonicalMessageSignals.shouldRepairMissingCanonicalSignals).mockReturnValue(false);
  vi.mocked(canonicalChannelState.persistCanonicalChannelState).mockResolvedValue(undefined as never);
  vi.mocked(channelMetadata.resolveChannelMetadata).mockResolvedValue({
    name: "general",
    conversationType: "public_channel",
  });
});

describe("Channel Routes", () => {
  describe("GET /", () => {
    it("returns canonical risk state derived from live alerts and flagged counts", async () => {
      vi.mocked(db.getAllChannelsWithState).mockResolvedValue([
        {
          channel_id: "C123ABC",
          name: "sage_team",
          conversation_type: "public_channel",
          status: "ready",
          initialized_at: new Date(),
          last_event_at: new Date(),
          updated_at: new Date(),
          running_summary: "There are active issues to watch.",
          sentiment_snapshot_json: null,
          signal: null,
          health: null,
          signal_confidence: null,
          risk_drivers_json: null,
          attention_summary_json: null,
          message_disposition_counts_json: null,
          effective_channel_mode: null,
          message_count: "734",
        },
      ]);
      vi.mocked(db.getChannelHealthCounts).mockResolvedValue([
        makeHealthCounts({
          open_alert_count: "2",
          flagged_message_count: "2",
          total_message_count: "16",
          skipped_message_count: "4",
          context_only_message_count: "4",
          total_analyzed_count: "12",
          anger_count: "2",
          joy_count: "3",
          sadness_count: "1",
          neutral_count: "5",
          fear_count: "1",
        }),
      ]);

      const res = await request(createApp()).get("/api/channels");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.channels[0]).toMatchObject({
        channelId: "C123ABC",
        signal: "escalating",
        health: "at-risk",
        healthCounts: {
          openAlertCount: 2,
          highSeverityAlertCount: 0,
          flaggedMessageCount: 2,
          highRiskMessageCount: 0,
        },
      });
    });

    it("elevates automation incident channels even without analyzed sentiment rows", async () => {
      vi.mocked(db.getAllChannelsWithState).mockResolvedValue([
        {
          channel_id: "CERR123",
          name: "sage_n8n_errors",
          conversation_type: "private_channel",
          status: "ready",
          initialized_at: new Date(),
          last_event_at: new Date(),
          updated_at: new Date(),
          running_summary: "Workflow failures are happening repeatedly.",
          sentiment_snapshot_json: null,
          signal: null,
          health: null,
          signal_confidence: null,
          risk_drivers_json: null,
          attention_summary_json: null,
          message_disposition_counts_json: null,
          effective_channel_mode: null,
          message_count: "44",
        },
      ]);
      vi.mocked(db.getChannelHealthCounts).mockResolvedValue([
        makeHealthCounts({
          channel_id: "CERR123",
          automation_incident_count: "8",
          critical_automation_incident_count: "6",
          automation_incident_24h_count: "5",
          critical_automation_incident_24h_count: "3",
          total_message_count: "8",
          skipped_message_count: "8",
        }),
      ]);

      const res = await request(createApp()).get("/api/channels");

      expect(res.status).toBe(200);
      expect(res.body.channels[0]).toMatchObject({
        channelId: "CERR123",
        signal: "escalating",
        health: "at-risk",
        healthCounts: {
          automationIncidentCount: 8,
          criticalAutomationIncidentCount: 6,
        },
      });
    });
  });

  describe("GET /:channelId/state", () => {
    it("returns 400 for invalid channel ID", async () => {
      const res = await request(createApp()).get("/api/channels/!!!invalid/state");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_params");
    });

    it("returns 404 when channel not found", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      const res = await request(createApp()).get("/api/channels/C123ABC/state");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("channel_not_found");
    });

    it("returns 200 with full state", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: null,
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState).mockResolvedValue(
        makeChannelState({
          participants_json: { U1: 5 },
          key_decisions_json: ["decision1"],
          signal: "elevated",
          health: "attention",
          signal_confidence: 0.7,
          risk_drivers_json: [
            {
              key: "open_alerts",
              label: "Open alerts",
              message: "1 open alert remains unresolved.",
              severity: "medium",
              category: "alert",
            },
          ],
          attention_summary_json: {
            status: "watch",
            title: "Worth reviewing",
            message: "1 open alert remains unresolved.",
            driverKeys: ["open_alerts"],
          },
          message_disposition_counts_json: {
            totalInWindow: 14,
            deepAiAnalyzed: 10,
            heuristicIncidentSignals: 0,
            contextOnly: 4,
            routineAcknowledgments: 0,
            storedWithoutDeepAnalysis: 4,
            inFlight: 0,
          },
          effective_channel_mode: "collaboration",
          sentiment_snapshot_json: {
            totalMessages: 10,
            highRiskCount: 0,
            updatedAt: "",
          },
          messages_since_last_llm: 3,
        }),
      );
      vi.mocked(db.getMessageCount).mockResolvedValue(42);
      vi.mocked(db.getChannelParticipantCounts).mockResolvedValue([{ user_id: "U1", message_count: 7 }]);
      vi.mocked(db.getChannelHealthCounts).mockResolvedValue([
        makeHealthCounts({
          open_alert_count: "1",
          flagged_message_count: "1",
          request_signal_count: "1",
          total_message_count: "14",
          skipped_message_count: "4",
          context_only_message_count: "4",
          total_analyzed_count: "10",
          anger_count: "1",
          joy_count: "4",
          sadness_count: "1",
          neutral_count: "4",
        }),
      ]);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([
        {
          id: "p1",
          workspace_id: "default",
          user_id: "U1",
          display_name: "Alice",
          real_name: "Alice Smith",
          profile_image: null,
          email: null,
          is_admin: false,
          is_owner: false,
          is_bot: false,
          fetched_at: new Date(),
        },
      ]);

      const res = await request(createApp()).get("/api/channels/C123ABC/state");
      expect(res.status).toBe(200);
      expect(res.body.channelId).toBe("C123ABC");
      expect(res.body.runningSummary).toBe("Test summary");
      expect(res.body.keyDecisions).toEqual(["decision1"]);
      expect(res.body.messageCount).toBe(42);
      expect(res.body.participants[0].displayName).toBe("Alice");
      expect(res.body.participants[0].messageCount).toBe(7);
      expect(res.body.signal).toBe("elevated");
      expect(res.body.health).toBe("attention");
      expect(res.body.healthCounts).toEqual({
        openAlertCount: 1,
        highSeverityAlertCount: 0,
        automationIncidentCount: 0,
        criticalAutomationIncidentCount: 0,
        automationIncident24hCount: 0,
        criticalAutomationIncident24hCount: 0,
        humanRiskSignalCount: 0,
        requestSignalCount: 1,
        decisionSignalCount: 0,
        resolutionSignalCount: 0,
        flaggedMessageCount: 1,
        highRiskMessageCount: 0,
        attentionThreadCount: 0,
        blockedThreadCount: 0,
        escalatedThreadCount: 0,
        riskyThreadCount: 0,
        totalMessageCount: 14,
        skippedMessageCount: 4,
        contextOnlyMessageCount: 4,
        ignoredMessageCount: 0,
        inflightMessageCount: 0,
      });
      expect(res.body.windowStats).toEqual({
        analysisWindowDays: 7,
        messageCountInWindow: 14,
        analyzedMessageCount: 10,
        skippedMessageCount: 4,
        contextOnlyMessageCount: 4,
        ignoredMessageCount: 0,
        inflightMessageCount: 0,
      });
      expect(res.body.importanceTierOverride).toBe("auto");
      expect(res.body.recommendedImportanceTier).toBe("standard");
      expect(res.body.effectiveImportanceTier).toBe("standard");
    });

    it("prefers live derived coverage counts over stale persisted channel state counts", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState).mockResolvedValue(
        makeChannelState({
          message_disposition_counts_json: {
            totalInWindow: 95,
            deepAiAnalyzed: 0,
            heuristicIncidentSignals: 1,
            contextOnly: 84,
            routineAcknowledgments: 7,
            storedWithoutDeepAnalysis: 95,
            inFlight: 0,
          },
        }),
      );
      vi.mocked(db.getMessageCount).mockResolvedValue(594);
      vi.mocked(db.getChannelParticipantCounts).mockResolvedValue([]);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([]);
      vi.mocked(db.getChannelHealthCounts).mockResolvedValue([
        makeHealthCounts({
          total_message_count: "94",
          skipped_message_count: "94",
          context_only_message_count: "84",
          ignored_message_count: "7",
          automation_incident_count: "1",
          total_analyzed_count: "0",
        }),
      ]);

      const res = await request(createApp()).get("/api/channels/C123ABC/state");

      expect(res.status).toBe(200);
      expect(res.body.windowStats.messageCountInWindow).toBe(94);
      expect(res.body.messageDispositionCounts).toEqual({
        totalInWindow: 94,
        deepAiAnalyzed: 0,
        heuristicIncidentSignals: 1,
        contextOnly: 86,
        routineAcknowledgments: 7,
        storedWithoutDeepAnalysis: 94,
        inFlight: 0,
      });
    });

    it("repairs missing canonical signals for skipped backfill-only channels before responding", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "CERR123",
        name: "sage_n8n_errors",
        conversation_type: "private_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState)
        .mockResolvedValueOnce(
          makeChannelState({
            channel_id: "CERR123",
            running_summary: "Stale summary",
            signal: "stable",
            health: "healthy",
            signal_confidence: 0.5,
            effective_channel_mode: "automation",
          }),
        )
        .mockResolvedValueOnce(
          makeChannelState({
            channel_id: "CERR123",
            running_summary: "Workflow errors need attention.",
            signal: "elevated",
            health: "attention",
            signal_confidence: 0.76,
            effective_channel_mode: "automation",
            risk_drivers_json: [
              {
                key: "operational_incidents",
                label: "Recent automation incidents",
                message: "8 operational incidents were detected in the current window.",
                severity: "high",
                category: "operational",
              },
            ],
            attention_summary_json: {
              status: "action",
              title: "Attention required",
              message: "8 operational incidents were detected in the current window.",
              driverKeys: ["operational_incidents"],
            },
            message_disposition_counts_json: {
              totalInWindow: 8,
              deepAiAnalyzed: 0,
              heuristicIncidentSignals: 8,
              contextOnly: 0,
              routineAcknowledgments: 0,
              storedWithoutDeepAnalysis: 8,
              inFlight: 0,
            },
          }),
        );
      vi.mocked(db.getMessageCount).mockResolvedValue(44);
      vi.mocked(db.getChannelParticipantCounts).mockResolvedValue([
        { user_id: "U1", message_count: 44 },
      ]);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([]);
      vi.mocked(db.getChannelHealthCounts)
        .mockResolvedValueOnce([
          makeHealthCounts({
            channel_id: "CERR123",
            total_message_count: "8",
            skipped_message_count: "8",
            total_analyzed_count: "0",
            context_only_message_count: "0",
            ignored_message_count: "0",
          }),
        ])
        .mockResolvedValueOnce([
          makeHealthCounts({
            channel_id: "CERR123",
            total_message_count: "8",
            skipped_message_count: "8",
            total_analyzed_count: "0",
            automation_incident_count: "8",
            critical_automation_incident_count: "8",
            automation_incident_24h_count: "3",
            critical_automation_incident_24h_count: "3",
          }),
        ]);
      vi.mocked(canonicalMessageSignals.shouldRepairMissingCanonicalSignals).mockReturnValue(true);
      vi.mocked(canonicalMessageSignals.hydrateChannelCanonicalSignals).mockResolvedValue({
        hydratedCount: 8,
        inspectedCount: 8,
      } as never);

      const res = await request(createApp()).get("/api/channels/CERR123/state");

      expect(res.status).toBe(200);
      expect(canonicalMessageSignals.hydrateChannelCanonicalSignals).toHaveBeenCalled();
      expect(canonicalChannelState.persistCanonicalChannelState).toHaveBeenCalled();
      expect(res.body.signal).toBe("escalating");
      expect(res.body.health).toBe("at-risk");
      expect(res.body.messageDispositionCounts.heuristicIncidentSignals).toBe(8);
    });

    it("reclassifies suspicious collaboration-channel incidents into related incident context", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState)
        .mockResolvedValueOnce(
          makeChannelState({
            channel_id: "C123ABC",
            signal: "stable",
            health: "healthy",
            effective_channel_mode: "collaboration",
          }),
        )
        .mockResolvedValueOnce(
          makeChannelState({
            channel_id: "C123ABC",
            signal: "stable",
            health: "healthy",
            effective_channel_mode: "collaboration",
          }),
        );
      vi.mocked(db.getMessageCount).mockResolvedValue(594);
      vi.mocked(db.getChannelParticipantCounts).mockResolvedValue([]);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([]);
      vi.mocked(db.getChannelHealthCounts)
        .mockResolvedValueOnce([
          makeHealthCounts({
            total_message_count: "94",
            skipped_message_count: "94",
            automation_incident_count: "1",
            total_analyzed_count: "0",
          }),
        ])
        .mockResolvedValueOnce([
          makeHealthCounts({
            total_message_count: "94",
            skipped_message_count: "94",
            automation_incident_count: "0",
            total_analyzed_count: "0",
          }),
        ]);
      vi.mocked(canonicalMessageSignals.reclassifyChannelCanonicalSignals).mockResolvedValue({
        reclassifiedCount: 94,
        inspectedCount: 94,
      } as never);
      vi.mocked(db.getRelatedIncidentMentions).mockResolvedValue([
        {
          message_ts: "1710000000.000100",
          source_channel_name: "sage_n8n_errors",
          source_channel_id: "CERR123",
          message_text: "Need to keep an eye on #sage_n8n_errors while we finish this work.",
          detected_at: new Date().toISOString(),
          blocks_local_work: false,
          incident_family: "workflow_error",
        },
      ] as never);

      const res = await request(createApp()).get("/api/channels/C123ABC/state");

      expect(res.status).toBe(200);
      expect(canonicalMessageSignals.reclassifyChannelCanonicalSignals).toHaveBeenCalled();
      expect(canonicalChannelState.persistCanonicalChannelState).toHaveBeenCalled();
      expect(res.body.signal).toBe("stable");
      expect(res.body.healthCounts.automationIncidentCount).toBe(0);
      expect(res.body.messageDispositionCounts.heuristicIncidentSignals).toBe(0);
      expect(res.body.relatedIncidents).toEqual([
        expect.objectContaining({
          sourceChannelId: "CERR123",
          sourceChannelName: "sage_n8n_errors",
          kind: "referenced_external_incident",
          blocksLocalWork: false,
        }),
      ]);
    });

    it("returns a risk-only notice for low-value channels", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "general",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState).mockResolvedValue(
        makeChannelState({
          running_summary: "This should be hidden in risk-only mode",
          participants_json: { U1: 5 },
        }),
      );
      vi.mocked(db.getMessageCount).mockResolvedValue(5);
      vi.mocked(db.getChannelParticipantCounts).mockResolvedValue([]);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([]);
      vi.mocked(db.getChannelHealthCounts).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/state");

      expect(res.status).toBe(200);
      expect(res.body.recommendedImportanceTier).toBe("low_value");
      expect(res.body.effectiveImportanceTier).toBe("low_value");
      expect(res.body.runningSummary).toContain("Risk-only monitoring is enabled");
    });
  });

  describe("GET /:channelId/messages", () => {
    it("returns 400 for invalid limit", async () => {
      const res = await request(createApp()).get("/api/channels/C123ABC/messages?limit=-1");
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown channel", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      const res = await request(createApp()).get("/api/channels/C123ABC/messages");
      expect(res.status).toBe(404);
    });

    it("returns 200 with top-level messages", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getTopLevelMessagesEnriched).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
    });
  });

  describe("GET /:channelId/threads", () => {
    it("returns surfaced threads plus recent fallback threads", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getActiveThreads).mockResolvedValue([
        {
          thread_ts: "1710000000.000100",
          reply_count: 4,
          last_activity: new Date().toISOString(),
        },
        {
          thread_ts: "1710000000.000200",
          reply_count: 2,
          last_activity: new Date().toISOString(),
        },
      ]);
      vi.mocked(db.getThreadInsightsBatch).mockResolvedValue([
        {
          workspace_id: "default",
          channel_id: "C123ABC",
          thread_ts: "1710000000.000100",
          summary: "Client is waiting on a fix.",
          new_decisions_json: [],
          open_questions_json: ["Who will take ownership?"],
          primary_issue: "fix ownership",
          thread_state: "blocked",
          emotional_temperature: "watch",
          operational_risk: "medium",
          surface_priority: "high",
          crucial_moments_json: [],
          last_meaningful_change_ts: "1710000000.000100",
          llm_provider: "openai",
          llm_model: "gpt-5.4",
          token_usage: null,
          messages_processed: 4,
          updated_at: new Date(),
          created_at: new Date(),
        },
      ] as never);
      vi.mocked(db.getMessagesEnriched).mockImplementation(async (_workspaceId, _channelId, input) => {
        if (input?.threadTs === "1710000000.000100") {
          return [
            {
              ts: "1710000000.000100",
              user_id: "U1",
              display_name: "Alice",
              real_name: "Alice Smith",
              text: "Can someone own this fix today?",
            },
          ] as never;
        }

        return [
          {
            ts: "1710000000.000200",
            user_id: "U2",
            display_name: "Bob",
            real_name: "Bob Jones",
            text: "Quick sync on diagrams later?",
          },
        ] as never;
      });

      const res = await request(createApp()).get("/api/channels/C123ABC/threads");

      expect(res.status).toBe(200);
      expect(res.body.threads).toHaveLength(1);
      expect(res.body.threads[0].threadTs).toBe("1710000000.000100");
      expect(res.body.recentThreads).toHaveLength(1);
      expect(res.body.recentThreads[0]).toMatchObject({
        threadTs: "1710000000.000200",
        rootMessage: {
          text: "Quick sync on diagrams later?",
        },
      });
    });
  });

  describe("GET /:channelId/live-messages", () => {
    it("returns latest recent activity first", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getMessagesEnriched).mockResolvedValue([
        {
          ts: "1710000000.000100",
          user_id: "U1",
          display_name: "Alice",
          real_name: "Alice Smith",
          text: "Older activity",
          thread_ts: null,
          source: "backfill",
          analysis_status: "skipped",
          created_at: new Date().toISOString(),
          files_json: [],
          links_json: [],
          ma_raw_llm_response: null,
          ma_dominant_emotion: null,
          fu_id: null,
          mt_candidate_kind: "context_only",
          mt_surface_priority: "none",
          mt_reason_codes: [],
          mt_state_transition: null,
        },
        {
          ts: "1710000001.000100",
          user_id: "U2",
          display_name: "Bob",
          real_name: "Bob Jones",
          text: "Newer activity",
          thread_ts: null,
          source: "realtime",
          analysis_status: "completed",
          created_at: new Date().toISOString(),
          files_json: [],
          links_json: [],
          ma_raw_llm_response: null,
          ma_dominant_emotion: null,
          fu_id: null,
          mt_candidate_kind: "context_only",
          mt_surface_priority: "none",
          mt_reason_codes: [],
          mt_state_transition: null,
        },
      ] as never);
      vi.mocked(db.getThreadInsightsBatch).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/live-messages?group=flat");

      expect(res.status).toBe(200);
      expect(res.body.messages.map((message: { ts: string }) => message.ts)).toEqual([
        "1710000001.000100",
        "1710000000.000100",
      ]);
    });

    it("does not label triage-only messages as crucial", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getMessagesEnriched).mockResolvedValue([
        {
          ts: "1710000000.000100",
          user_id: "U1",
          display_name: "Alice",
          real_name: "Alice Smith",
          text: "Take a look at this plan and let me know what you think.",
          thread_ts: "1710000000.000100",
          source: "realtime",
          analysis_status: "skipped",
          created_at: new Date().toISOString(),
          files_json: [],
          links_json: [],
          ma_raw_llm_response: null,
          ma_dominant_emotion: null,
          fu_id: null,
          mt_candidate_kind: "thread_turning_point",
          mt_surface_priority: "high",
          mt_reason_codes: ["ownership_signal"],
          mt_state_transition: "investigating",
        },
      ] as never);
      vi.mocked(db.getThreadInsightsBatch).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/live-messages?group=flat");

      expect(res.status).toBe(200);
      expect(res.body.messages[0]).toMatchObject({
        ts: "1710000000.000100",
        isCrucial: false,
        crucialReason: null,
        triage: {
          candidateKind: "thread_turning_point",
          surfacePriority: "high",
        },
      });
    });

    it("labels live messages as crucial only when thread insight surfaced that moment", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1",
        workspace_id: "default",
        channel_id: "C123ABC",
        name: "sage_team",
        conversation_type: "public_channel",
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getMessagesEnriched).mockResolvedValue([
        {
          ts: "1710000000.000100",
          user_id: "U1",
          display_name: "Alice",
          real_name: "Alice Smith",
          text: "Client is blocked until we confirm the migration plan.",
          thread_ts: "1710000000.000100",
          source: "realtime",
          analysis_status: "completed",
          created_at: new Date().toISOString(),
          files_json: [],
          links_json: [],
          ma_raw_llm_response: null,
          ma_dominant_emotion: null,
          fu_id: null,
          mt_candidate_kind: "thread_turning_point",
          mt_surface_priority: "high",
          mt_reason_codes: ["blocker_signal"],
          mt_state_transition: "blocked",
        },
      ] as never);
      vi.mocked(db.getThreadInsightsBatch).mockResolvedValue([
        {
          workspace_id: "default",
          channel_id: "C123ABC",
          thread_ts: "1710000000.000100",
          summary: "Client is waiting on a migration answer.",
          new_decisions_json: [],
          open_questions_json: ["Who will confirm the migration plan?"],
          primary_issue: "migration confirmation",
          thread_state: "blocked",
          emotional_temperature: "watch",
          operational_risk: "medium",
          surface_priority: "high",
          crucial_moments_json: [
            {
              messageTs: "1710000000.000100",
              kind: "turning_point",
              reason: "This message introduced the blocker that now needs attention.",
              surfacePriority: "high",
            },
          ],
          last_meaningful_change_ts: "1710000000.000100",
          llm_provider: "openai",
          llm_model: "gpt-5.4",
          token_usage: null,
          messages_processed: 3,
          updated_at: new Date(),
          created_at: new Date(),
        },
      ] as never);

      const res = await request(createApp()).get("/api/channels/C123ABC/live-messages?group=flat");

      expect(res.status).toBe(200);
      expect(res.body.messages[0]).toMatchObject({
        ts: "1710000000.000100",
        isCrucial: true,
        crucialReason: "This message introduced the blocker that now needs attention.",
      });
    });
  });

  describe("GET /:channelId/analytics", () => {
    it("returns 400 for invalid emotion filter", async () => {
      const res = await request(createApp()).get("/api/channels/C123ABC/analytics?emotion=invalid");
      expect(res.status).toBe(400);
    });

    it("returns 200 with analytics and filters", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getMessageAnalytics).mockResolvedValue([
        {
          id: "ma-1",
          workspace_id: "default",
          channel_id: "C123ABC",
          message_ts: "1710000000.000100",
          dominant_emotion: "anger",
          interaction_tone: "corrective",
          confidence: 0.92,
          escalation_risk: "medium",
          themes: ["handoff"],
          decision_signal: false,
          explanation: "This message signals elevated frustration.",
          raw_llm_response: { sarcasm_detected: false },
          llm_provider: "openai",
          llm_model: "gpt-5.4",
          token_usage: null,
          message_intent: "question",
          is_actionable: true,
          is_blocking: false,
          urgency_level: "medium",
          created_at: new Date(),
          user_id: "U1",
          display_name: "Alice",
          real_name: "Alice Smith",
          message_text: "Can someone review this diagram?",
          thread_ts: null,
          message_at: new Date(),
          author_flagged_count: 3,
          total_count: 1,
        },
      ]);

      const res = await request(createApp()).get("/api/channels/C123ABC/analytics?risk=flagged");
      expect(res.status).toBe(200);
      expect(db.getMessageAnalytics).toHaveBeenCalledWith(
        "default",
        "C123ABC",
        expect.objectContaining({ risk: "flagged" }),
      );
      expect(res.body.filters.risk).toBe("flagged");
      expect(res.body.analytics[0]).toMatchObject({
        messageTs: "1710000000.000100",
        escalationRisk: "medium",
        authorFlaggedCount: 3,
      });
    });
  });

  describe("GET /:channelId/summary", () => {
    it("returns 404 when channel not found", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      const res = await request(createApp()).get("/api/channels/C123ABC/summary");
      expect(res.status).toBe(404);
    });

    it("returns 200 with summary data", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getChannelSummary).mockResolvedValue({
        runningSummary: "A summary",
        keyDecisions: ["d1"],
        totalRollups: 3,
        latestRollupAt: new Date(),
        totalMessages: 100,
        totalAnalyses: 10,
        sentimentSnapshot: { totalMessages: 100, highRiskCount: 2, updatedAt: "" },
      });

      const res = await request(createApp()).get("/api/channels/C123ABC/summary");
      expect(res.status).toBe(200);
      expect(res.body.channelId).toBe("C123ABC");
      expect(res.body.runningSummary).toBe("A summary");
      expect(res.body.totalRollups).toBe(3);
    });
  });

  describe("POST /:channelId/backfill", () => {
    it("returns 202 with jobId and preserves Slack conversation type", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      vi.mocked(channelMetadata.resolveChannelMetadata).mockResolvedValue({
        name: "sage_team",
        conversationType: "private_channel",
      });
      vi.mocked(db.upsertChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: "sage_team", conversation_type: "private_channel", status: "pending", initialized_at: null,
        last_event_at: null, created_at: new Date(), updated_at: new Date(),
      });

      const res = await request(createApp())
        .post("/api/channels/C123ABC/backfill")
        .send({ reason: "test" });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe("job-backfill-1");
      expect(db.upsertChannel).toHaveBeenCalledWith(
        "default",
        "C123ABC",
        "pending",
        "sage_team",
        "private_channel",
      );
    });

    it("returns 503 when Slack metadata is unavailable for an unknown channel", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      vi.mocked(channelMetadata.resolveChannelMetadata).mockResolvedValue(null);

      const res = await request(createApp())
        .post("/api/channels/C123ABC/backfill")
        .send({ reason: "test" });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("channel_metadata_unavailable");
      expect(db.upsertChannel).not.toHaveBeenCalled();
    });
  });

  describe("POST /:channelId/analyze", () => {
    it("returns 400 when mode=thread without threadTs", async () => {
      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "thread" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when mode=visible_messages without targets", async () => {
      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "visible_messages" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown channel", async () => {
      vi.mocked(db.getChannel).mockResolvedValue(null);
      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({});
      expect(res.status).toBe(404);
    });

    it("returns 202 for valid analysis request", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getUnresolvedMessageTs).mockResolvedValue([]);

      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "channel" });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe("job-analyze-1");
      expect(res.body.effectiveMode).toBe("latest");
    });

    it("queues thread_messages with unresolved targets", async () => {
      vi.mocked(db.getChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });

      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "thread_messages", threadTs: "1710000000.000001" });

      expect(res.status).toBe(202);
      expect(db.getUnresolvedMessageTs).toHaveBeenCalledWith(
        "default",
        "C123ABC",
        expect.objectContaining({
          threadTs: "1710000000.000001",
          hoursBack: 168,
          limit: 50,
        }),
      );
    });
  });
});
