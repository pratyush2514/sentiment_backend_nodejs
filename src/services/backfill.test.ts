import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    BACKFILL_DAYS: 30,
    BACKFILL_MAX_PAGES: 2,
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
    }),
  },
}));

vi.mock("../db/queries.js", () => ({
  getChannel: vi.fn().mockResolvedValue({
    status: "pending",
    name: "sage_team",
    conversation_type: "public_channel",
  }),
  getFollowUpRule: vi.fn().mockResolvedValue(null),
  upsertChannel: vi.fn(),
  updateChannelStatus: vi.fn(),
  upsertMessage: vi.fn(),
  getDistinctUserIds: vi.fn().mockResolvedValue(["U1"]),
  getUserProfiles: vi.fn().mockImplementation(async (_workspaceId: string, userIds: string[]) =>
    userIds.map((userId) => ({
      user_id: userId,
      display_name: userId === "U1" ? "Bhavesh" : userId,
      real_name: userId === "U1" ? "Bhavesh" : userId,
      profile_image: null,
    })),
  ),
  syncChannelMembers: vi.fn(),
  getMessages: vi.fn().mockResolvedValue([
    {
      ts: "1710000000.000100",
      text: "Can someone check Mixpanel access?",
      user_id: "U1",
    },
  ]),
  getThreads: vi.fn().mockResolvedValue([]),
  getMessageCount: vi.fn().mockResolvedValue(1),
  getChannelState: vi.fn().mockResolvedValue(null),
  getChannelHealthCounts: vi.fn().mockResolvedValue([
    {
      channel_id: "C123ABC",
      total_message_count: "1",
      total_analyzed_count: "0",
      negative_count: "0",
      medium_or_higher_count: "0",
      high_count: "0",
      context_only_message_count: "1",
      ignored_message_count: "0",
      request_signal_count: "0",
      decision_signal_count: "0",
      resolution_signal_count: "0",
      human_risk_signal_count: "0",
      automation_incident_count: "0",
      critical_automation_incident_count: "0",
      automation_incident_24h_count: "0",
      critical_automation_incident_24h_count: "0",
      skipped_message_count: "1",
      processing_count: "0",
      analysis_window_days: 7,
    },
  ]),
  getChannelParticipantCounts: vi.fn().mockResolvedValue([
    { user_id: "U1", message_count: 1 },
  ]),
  upsertChannelState: vi.fn(),
  markChannelBackfillMessagesSkipped: vi.fn().mockResolvedValue(1),
  getEffectiveAnalysisWindowDays: vi.fn().mockResolvedValue(7),
  getActiveThreads: vi.fn().mockResolvedValue([
    {
      thread_ts: "1710000000.000100",
      reply_count: 2,
      last_activity: new Date(),
    },
  ]),
  getUnresolvedMessageTs: vi.fn().mockResolvedValue(["1710000000.000100"]),
}));

vi.mock("../services/channelMetadata.js", () => ({
  resolveChannelMetadata: vi.fn().mockResolvedValue({
    name: "sage_team",
    conversationType: "public_channel",
  }),
}));

const fetchChannelHistory = vi.fn();
const fetchChannelMembers = vi.fn();
const fetchThreadReplies = vi.fn();

vi.mock("./slackClientFactory.js", () => ({
  getSlackClient: vi.fn().mockImplementation(async () => ({
    fetchChannelHistory,
    fetchChannelMembers,
    fetchThreadReplies,
  })),
}));

vi.mock("./userProfiles.js", () => ({
  batchResolveUsers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueSummaryRollup: vi.fn().mockResolvedValue("job-rollup-1"),
}));

vi.mock("./backfillSummary.js", () => ({
  materializeBackfillSummary: vi.fn().mockResolvedValue({
    summary: "The team is asking for Mixpanel access and waiting on ownership.",
    keyDecisions: [],
    messageCount: 1,
    summaryType: "llm",
  }),
}));

vi.mock("./canonicalMessageSignals.js", () => ({
  persistCanonicalMessageSignal: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const { materializeBackfillSummary } = await import("./backfillSummary.js");
const { runBackfill } = await import("./backfill.js");

beforeEach(() => {
  vi.clearAllMocks();
  fetchChannelHistory.mockResolvedValue({
    messages: [
      {
        ts: "1710000000.000100",
        user: "U1",
        text: "Can someone check Mixpanel access?",
        reply_count: 0,
      },
    ],
    response_metadata: {},
  });
  fetchChannelMembers.mockResolvedValue({
    members: ["U1"],
    response_metadata: {},
  });
  fetchThreadReplies.mockResolvedValue({
    messages: [],
    response_metadata: {},
  });
});

describe("runBackfill", () => {
  it("marks the channel ready only after the first summary has been materialized", async () => {
    const order: string[] = [];

    vi.mocked(db.updateChannelStatus).mockImplementation(async (_workspaceId, _channelId, status) => {
      order.push(`status:${status}`);
    });
    vi.mocked(materializeBackfillSummary).mockImplementation(async () => {
      order.push("summary");
      return {
        summary: "The team is asking for Mixpanel access and waiting on ownership.",
        keyDecisions: [],
        messageCount: 1,
        summaryType: "llm",
      };
    });
    vi.mocked(boss.enqueueSummaryRollup).mockImplementation(async () => {
      order.push("seed");
      return "job-rollup-1";
    });

    await runBackfill("default", "C123ABC", "test");

    expect(order).toContain("summary");
    expect(order.indexOf("summary")).toBeGreaterThan(order.indexOf("status:initializing"));
    expect(order.indexOf("summary")).toBeLessThan(order.indexOf("status:ready"));
    expect(order.indexOf("status:ready")).toBeLessThan(order.indexOf("seed"));
  });

  it("normalizes historical backfill messages to skipped before marking the channel ready", async () => {
    const order: string[] = [];

    vi.mocked(db.markChannelBackfillMessagesSkipped).mockImplementation(async () => {
      order.push("normalize");
      return 3;
    });
    vi.mocked(db.updateChannelStatus).mockImplementation(async (_workspaceId, _channelId, status) => {
      order.push(`status:${status}`);
    });

    await runBackfill("default", "C123ABC", "test");

    expect(order.indexOf("normalize")).toBeGreaterThan(order.indexOf("status:initializing"));
    expect(order.indexOf("normalize")).toBeLessThan(order.indexOf("status:ready"));
  });
});
