import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { NODE_ENV: "test" },
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
  getChannel: vi.fn(),
  getChannelState: vi.fn(),
  getMessageCount: vi.fn(),
  getThreads: vi.fn(),
  getUserProfiles: vi.fn(),
  getMessagesEnriched: vi.fn(),
  getTopLevelMessagesEnriched: vi.fn(),
  getThreadRepliesEnriched: vi.fn(),
  getActiveThreads: vi.fn(),
  getMessageAnalytics: vi.fn(),
  upsertChannel: vi.fn(),
  getChannelSummary: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueBackfill: vi.fn().mockResolvedValue("job-backfill-1"),
  enqueueLLMAnalyze: vi.fn().mockResolvedValue("job-analyze-1"),
}));

const db = await import("../db/queries.js");
const _boss = await import("../queue/boss.js");
const { channelsRouter } = await import("./channels.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = "test-req-id";
    next();
  });
  app.use("/api/channels", channelsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Channel Routes", () => {
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
        status: "ready",
        initialized_at: new Date(),
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
      vi.mocked(db.getChannelState).mockResolvedValue({
        id: "uuid-2",
        workspace_id: "default",
        channel_id: "C123ABC",
        running_summary: "Test summary",
        participants_json: { U1: 5 },
        active_threads_json: [],
        key_decisions_json: ["decision1"],
        sentiment_snapshot_json: { totalMessages: 10, highRiskCount: 0, updatedAt: "" },
        messages_since_last_llm: 3,
        last_llm_run_at: null,
        llm_cooldown_until: null,
        last_reconcile_at: null,
        messages_since_last_rollup: 0,
        last_rollup_at: null,
        updated_at: new Date(),
      });
      vi.mocked(db.getMessageCount).mockResolvedValue(42);
      vi.mocked(db.getThreads).mockResolvedValue([]);
      vi.mocked(db.getUserProfiles).mockResolvedValue([
        { id: "p1", workspace_id: "default", user_id: "U1", display_name: "Alice", real_name: "Alice Smith", profile_image: null, fetched_at: new Date() },
      ]);

      const res = await request(createApp()).get("/api/channels/C123ABC/state");
      expect(res.status).toBe(200);
      expect(res.body.channelId).toBe("C123ABC");
      expect(res.body.runningSummary).toBe("Test summary");
      expect(res.body.keyDecisions).toEqual(["decision1"]);
      expect(res.body.messageCount).toBe(42);
      expect(res.body.participants[0].displayName).toBe("Alice");
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
        name: null, status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getTopLevelMessagesEnriched).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
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
        name: null, status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
      vi.mocked(db.getMessageAnalytics).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/channels/C123ABC/analytics?emotion=joy");
      expect(res.status).toBe(200);
      expect(res.body.filters.emotion).toBe("joy");
      expect(res.body.analytics).toEqual([]);
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
        name: null, status: "ready", initialized_at: new Date(),
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
    it("returns 202 with jobId", async () => {
      vi.mocked(db.upsertChannel).mockResolvedValue({
        id: "uuid-1", workspace_id: "default", channel_id: "C123ABC",
        name: null, status: "pending", initialized_at: null,
        last_event_at: null, created_at: new Date(), updated_at: new Date(),
      });

      const res = await request(createApp())
        .post("/api/channels/C123ABC/backfill")
        .send({ reason: "test" });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe("job-backfill-1");
    });
  });

  describe("POST /:channelId/analyze", () => {
    it("returns 400 when mode=thread without threadTs", async () => {
      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "thread" });
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
        name: null, status: "ready", initialized_at: new Date(),
        last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });

      const res = await request(createApp())
        .post("/api/channels/C123ABC/analyze")
        .send({ mode: "channel" });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe("job-analyze-1");
    });
  });
});
