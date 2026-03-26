import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FathomConnectionRow } from "../types/database.js";

vi.mock("../config.js", () => ({
  config: {
    PUBLIC_BASE_URL: "https://pulse.ngrok.app",
    FATHOM_ALLOW_INSECURE_WEBHOOKS: false,
    FATHOM_WEBHOOK_SECRET: "",
    FATHOM_HISTORICAL_SYNC_STALE_MINUTES: 45,
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

vi.mock("../middleware/slackSignature.js", () => ({
  getRawBody: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getFathomConnection: vi.fn(),
  updateFathomDefaultChannel: vi.fn(),
  queueFathomHistoricalSync: vi.fn(),
  failFathomHistoricalSync: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueMeetingIngest: vi.fn(),
  enqueueMeetingHistoricalSync: vi.fn(),
  getQueue: vi.fn().mockReturnValue(null),
}));

vi.mock("../services/fathomClient.js", () => ({
  registerFathomWebhook: vi.fn().mockResolvedValue({
    webhookId: "wh_123",
    webhookSecret: "secret_123",
  }),
  validateFathomApiKey: vi.fn().mockResolvedValue({
    status: "valid",
    message: "ok",
  }),
}));

vi.mock("../services/fathomTokenManager.js", () => ({
  getFathomWebhookSecret: vi.fn(),
  revokeFathomConnection: vi.fn().mockResolvedValue(undefined),
  storeFathomApiKey: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const fathomClient = await import("../services/fathomClient.js");
const { fathomRouter } = await import("./fathom.js");

function makeConnection(
  overrides: Partial<FathomConnectionRow> = {},
): FathomConnectionRow {
  return {
    id: "fathom-1",
    workspace_id: "default",
    fathom_user_email: "owner@example.com",
    encrypted_api_key: "enc",
    webhook_id: "wh_123",
    webhook_secret: "enc-secret",
    status: "active",
    default_channel_id: null,
    last_synced_at: null,
    last_error: null,
    historical_sync_status: "idle",
    historical_sync_window_days: 14,
    historical_sync_started_at: null,
    historical_sync_completed_at: null,
    historical_sync_discovered_count: 0,
    historical_sync_imported_count: 0,
    historical_sync_last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = "default";
    next();
  });
  app.use("/api/fathom", fathomRouter);
  return app;
}

describe("fathomRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues historical sync after a first successful connection", async () => {
    vi.mocked(db.getFathomConnection)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(
        makeConnection({
          historical_sync_status: "queued",
        }) as never,
      );
    vi.mocked(db.queueFathomHistoricalSync).mockResolvedValue(
      makeConnection({
        historical_sync_status: "queued",
      }) as never,
    );

    const res = await request(buildApp())
      .post("/api/fathom/connection")
      .send({ api_key: "fathom_valid_key" });

    expect(res.status).toBe(200);
    expect(vi.mocked(fathomClient.validateFathomApiKey)).toHaveBeenCalledWith(
      "fathom_valid_key",
    );
    expect(vi.mocked(db.queueFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      14,
    );
    expect(vi.mocked(boss.enqueueMeetingHistoricalSync)).toHaveBeenCalledWith({
      workspaceId: "default",
      windowDays: 14,
      requestedBy: "auto_connect",
    });
    expect(res.body.historicalSync).toMatchObject({
      status: "queued",
      windowDays: 14,
    });
  });

  it("does not enqueue another manual sync when one is already running", async () => {
    vi.mocked(db.getFathomConnection).mockResolvedValue(
      makeConnection({
        historical_sync_status: "running",
        historical_sync_started_at: new Date("2026-03-26T10:00:00.000Z"),
      }) as never,
    );

    const res = await request(buildApp()).post("/api/fathom/connection/sync");

    expect(res.status).toBe(202);
    expect(vi.mocked(db.queueFathomHistoricalSync)).not.toHaveBeenCalled();
    expect(vi.mocked(boss.enqueueMeetingHistoricalSync)).not.toHaveBeenCalled();
    expect(res.body.historicalSync).toMatchObject({
      status: "running",
      windowDays: 14,
    });
  });

  it("recovers a stale running sync when the user manually retries", async () => {
    vi.mocked(db.getFathomConnection)
      .mockResolvedValueOnce(
        makeConnection({
          historical_sync_status: "running",
          historical_sync_started_at: new Date(Date.now() - 60 * 60 * 1000),
          historical_sync_discovered_count: 4,
          historical_sync_imported_count: 2,
        }) as never,
      )
      .mockResolvedValueOnce(
        makeConnection({
          historical_sync_status: "queued",
          historical_sync_discovered_count: 0,
          historical_sync_imported_count: 0,
        }) as never,
      );
    vi.mocked(db.queueFathomHistoricalSync).mockResolvedValue(
      makeConnection({
        historical_sync_status: "queued",
      }) as never,
    );

    const res = await request(buildApp()).post("/api/fathom/connection/sync");

    expect(res.status).toBe(202);
    expect(vi.mocked(db.failFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        lastError: "historical_sync_stalled:manual_retry",
      }),
    );
    expect(vi.mocked(db.queueFathomHistoricalSync)).toHaveBeenCalledWith(
      "default",
      14,
    );
    expect(vi.mocked(boss.enqueueMeetingHistoricalSync)).toHaveBeenCalledWith({
      workspaceId: "default",
      windowDays: 14,
      requestedBy: "manual",
    });
    expect(res.body.historicalSync).toMatchObject({
      status: "queued",
      windowDays: 14,
    });
  });
});
