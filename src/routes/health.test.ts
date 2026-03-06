import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the router
vi.mock("../db/pool.js", () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
}));

vi.mock("../queue/boss.js", () => ({
  getQueue: vi.fn().mockReturnValue({}),
}));

vi.mock("../config.js", () => ({
  config: {
    HEALTHCHECK_DB_TIMEOUT_MS: 3000,
  },
}));

const { healthRouter } = await import("./health.js");
const { checkConnection } = await import("../db/pool.js");
const { getQueue } = await import("../queue/boss.js");

function createApp() {
  const app = express();
  app.use("/", healthRouter);
  return app;
}

describe("Health Routes", () => {
  describe("GET /health/live", () => {
    it("returns 200 with status ok", async () => {
      const app = createApp();
      const res = await request(app).get("/health/live");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /health/ready", () => {
    it("returns 200 when DB and queue are healthy", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(getQueue).mockReturnValue({} as ReturnType<typeof getQueue>);

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.database).toBe("connected");
      expect(res.body.checks.queue).toBe("running");
    });

    it("returns 503 when DB is unavailable", async () => {
      vi.mocked(checkConnection).mockResolvedValue(false);
      vi.mocked(getQueue).mockReturnValue({} as ReturnType<typeof getQueue>);

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.database).toBe("disconnected");
    });

    it("returns 503 when queue is not started", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(getQueue).mockReturnValue(null);

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.queue).toBe("not_started");
    });

    it("includes uptime in response", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(getQueue).mockReturnValue({} as ReturnType<typeof getQueue>);

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.body.uptime).toBeTypeOf("number");
    });
  });

  describe("GET /", () => {
    it("redirects to /health/ready", async () => {
      const app = createApp();
      const res = await request(app).get("/");
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe("/health/ready");
    });
  });
});
