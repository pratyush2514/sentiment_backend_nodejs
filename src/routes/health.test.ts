import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the router
vi.mock("../db/pool.js", () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  checkDirectConnection: vi.fn().mockResolvedValue(true),
  getMigrationStatus: vi.fn().mockResolvedValue({
    applied: ["001.sql"],
    pending: [],
    upToDate: true,
  }),
}));

vi.mock("../queue/boss.js", () => ({
  getQueueRuntimeState: vi.fn().mockReturnValue({
    started: true,
    workersRegistered: true,
  }),
}));

vi.mock("../services/runtimeState.js", () => ({
  getRuntimeState: vi.fn().mockReturnValue({
    role: "all",
    httpServing: true,
    schedulerRunning: true,
    queueStarted: true,
    workersRegistered: true,
    lastQueueStartedAt: null,
    lastWorkersRegisteredAt: null,
  }),
}));

vi.mock("../config.js", () => ({
  config: {
    HEALTHCHECK_DB_TIMEOUT_MS: 3000,
    HEALTHCHECK_MIGRATION_TIMEOUT_MS: 5000,
  },
}));

const { healthRouter } = await import("./health.js");
const { checkConnection, checkDirectConnection, getMigrationStatus } = await import("../db/pool.js");
const { getQueueRuntimeState } = await import("../queue/boss.js");
const { getRuntimeState } = await import("../services/runtimeState.js");

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
  app.use("/", healthRouter);
  return forceLocalhostListen(app);
}

beforeEach(() => {
  vi.mocked(checkConnection).mockResolvedValue(true);
  vi.mocked(checkDirectConnection).mockResolvedValue(true);
  vi.mocked(getMigrationStatus).mockResolvedValue({
    applied: ["001.sql"],
    pending: [],
    upToDate: true,
  });
  vi.mocked(getQueueRuntimeState).mockReturnValue({
    started: true,
    workersRegistered: true,
  });
  vi.mocked(getRuntimeState).mockReturnValue({
    role: "all",
    httpServing: true,
    schedulerRunning: true,
    queueStarted: true,
    workersRegistered: true,
    lastQueueStartedAt: null,
    lastWorkersRegisteredAt: null,
  });
});

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
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getMigrationStatus).mockResolvedValue({
        applied: ["001.sql"],
        pending: [],
        upToDate: true,
      });
      vi.mocked(getQueueRuntimeState).mockReturnValue({
        started: true,
        workersRegistered: true,
      });

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.database).toBe("connected");
      expect(res.body.checks.directDatabase).toBe("connected");
      expect(res.body.checks.queue).toBe("running");
      expect(res.body.checks.migrations).toBe("up_to_date");
    });

    it("returns 503 when DB is unavailable", async () => {
      vi.mocked(checkConnection).mockResolvedValue(false);
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getQueueRuntimeState).mockReturnValue({
        started: true,
        workersRegistered: true,
      });

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.database).toBe("disconnected");
    });

    it("returns 503 when direct DB is unavailable", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkDirectConnection).mockResolvedValue(false);

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.directDatabase).toBe("disconnected");
    });

    it("returns 503 when queue is not started", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getQueueRuntimeState).mockReturnValue({
        started: false,
        workersRegistered: false,
      });

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.queue).toBe("not_started");
    });

    it("returns 503 when migrations are pending", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getMigrationStatus).mockResolvedValue({
        applied: ["001.sql"],
        pending: ["002.sql"],
        upToDate: false,
      });

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.checks.migrations).toBe("pending");
    });

    it("returns 503 when worker role has no registered workers", async () => {
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getRuntimeState).mockReturnValue({
        role: "worker",
        httpServing: false,
        schedulerRunning: false,
        queueStarted: true,
        workersRegistered: false,
        lastQueueStartedAt: null,
        lastWorkersRegisteredAt: null,
      });
      vi.mocked(getQueueRuntimeState).mockReturnValue({
        started: true,
        workersRegistered: false,
      });

      const app = createApp();
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.checks.workers).toBe("not_registered");
    });

    it("includes uptime in response", async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkDirectConnection).mockResolvedValue(true);
      vi.mocked(getQueueRuntimeState).mockReturnValue({
        started: true,
        workersRegistered: true,
      });

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
