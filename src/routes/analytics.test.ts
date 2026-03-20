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
  getSentimentTrends: vi.fn(),
  getCostBreakdown: vi.fn(),
  getAnalyticsOverview: vi.fn(),
}));

const db = await import("../db/queries.js");
const { analyticsRouter } = await import("./analytics.js");

function forceLocalhostListen(app: express.Express) {
  const originalListen = app.listen.bind(app);
  app.listen = ((...args: unknown[]) => {
    if (args.length === 0) {
      return originalListen(0, "127.0.0.1");
    }
    if (typeof args[0] === "function") {
      return originalListen(0, "127.0.0.1", args[0] as () => void);
    }
    if (typeof args[0] === "number") {
      const [port, hostOrCallback, maybeCallback] = args;
      if (args.length === 1 || hostOrCallback == null) {
        return originalListen(port, "127.0.0.1");
      }
      if (typeof hostOrCallback === "function") {
        return originalListen(port, "127.0.0.1", hostOrCallback as () => void);
      }
      if (typeof hostOrCallback === "string") {
        return originalListen(port, "127.0.0.1", maybeCallback as (() => void) | undefined);
      }
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
  app.use("/api/analytics", analyticsRouter);
  return forceLocalhostListen(app);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Analytics Routes", () => {
  describe("GET /sentiment-trends", () => {
    it("returns 200 with trend buckets", async () => {
      vi.mocked(db.getSentimentTrends).mockResolvedValue([
        { bucket: "2026-03-05T00:00:00.000Z", total: 10, emotions: { joy: 5, neutral: 3, anger: 2 }, avgConfidence: 0.85, highRiskCount: 1 },
      ]);

      const res = await request(createApp()).get("/api/analytics/sentiment-trends");
      expect(res.status).toBe(200);
      expect(res.body.granularity).toBe("daily");
      expect(res.body.buckets).toHaveLength(1);
      expect(res.body.buckets[0].total).toBe(10);
    });

    it("passes channel_id filter to query", async () => {
      vi.mocked(db.getSentimentTrends).mockResolvedValue([]);

      const res = await request(createApp())
        .get("/api/analytics/sentiment-trends?channel_id=C123ABC&granularity=hourly");
      expect(res.status).toBe(200);
      expect(res.body.granularity).toBe("hourly");
      expect(res.body.filters.channelId).toBe("C123ABC");
      expect(db.getSentimentTrends).toHaveBeenCalledWith("default", expect.objectContaining({
        channelId: "C123ABC",
        granularity: "hourly",
      }));
    });

    it("returns 400 for invalid channel_id format", async () => {
      const res = await request(createApp())
        .get("/api/analytics/sentiment-trends?channel_id=!!!invalid");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_query");
    });
  });

  describe("GET /costs", () => {
    it("returns 200 with cost breakdown", async () => {
      vi.mocked(db.getCostBreakdown).mockResolvedValue([
        {
          day: "2026-03-05",
          llmProvider: "openai",
          llmModel: "gpt-4o-mini",
          jobType: "llm.analyze",
          totalRequests: 10,
          totalPromptTokens: 5000,
          totalCompletionTokens: 1000,
          totalCostUsd: 0.012,
        },
      ]);

      const res = await request(createApp()).get("/api/analytics/costs");
      expect(res.status).toBe(200);
      expect(res.body.breakdown).toHaveLength(1);
      expect(res.body.totalCostUsd).toBe(0.012);
    });

    it("returns empty breakdown when no costs", async () => {
      vi.mocked(db.getCostBreakdown).mockResolvedValue([]);

      const res = await request(createApp()).get("/api/analytics/costs");
      expect(res.status).toBe(200);
      expect(res.body.breakdown).toEqual([]);
      expect(res.body.totalCostUsd).toBe(0);
    });
  });

  describe("GET /overview", () => {
    it("returns 200 with all dashboard fields", async () => {
      vi.mocked(db.getAnalyticsOverview).mockResolvedValue({
        totalMessages: 500,
        totalAnalyses: 25,
        emotionDistribution: { joy: 10, neutral: 8, anger: 5, sadness: 2 },
        avgSentiment: 0.56,
        highRiskCount: 3,
        openFollowUpCount: 2,
        highSeverityFollowUpCount: 1,
        flaggedMessageCount: 5,
        totalCostUsd: 0.55,
        costTodayUsd: 0.08,
        activeChannels: 2,
        teamHealth: 78,
      });

      const res = await request(createApp()).get("/api/analytics/overview");
      expect(res.status).toBe(200);
      expect(res.body.totalMessages).toBe(500);
      expect(res.body.totalAnalyses).toBe(25);
      expect(res.body.activeChannels).toBe(2);
      expect(res.body.emotionDistribution.joy).toBe(10);
      expect(res.body.avgSentiment).toBe(0.56);
      expect(res.body.highRiskCount).toBe(3);
      expect(res.body.teamHealth).toBe(78);
      expect(res.body.costTodayUsd).toBe(0.08);
    });
  });
});
