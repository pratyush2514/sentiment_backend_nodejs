import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    ENCRYPTION_KEY: "a".repeat(64),
    SUPABASE_JWT_SECRET: "",
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

vi.mock("../middleware/apiAuth.js", () => ({
  requireApiAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.workspaceId = "T123";
    next();
  },
}));

vi.mock("../db/queries.js", () => ({
  upsertWorkspace: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  deactivateWorkspace: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  cancelWorkspaceJobs: vi.fn().mockResolvedValue(0),
  enqueueChannelDiscovery: vi.fn().mockResolvedValue("job-discovery-1"),
}));

vi.mock("../services/slackClientFactory.js", () => ({
  invalidateWorkspaceCache: vi.fn(),
}));

vi.mock("../services/tokenEncryption.js", () => ({
  encryptToken: vi.fn((plaintext: string) => ({
    ciphertext: Buffer.from(plaintext, "utf8"),
    iv: Buffer.from(`iv:${plaintext}`, "utf8"),
    tag: Buffer.from(`tag:${plaintext}`, "utf8"),
  })),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const { authRouter } = await import("./auth.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = "test-req-id";
    next();
  });
  app.use("/api/auth", authRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.upsertWorkspace).mockResolvedValue({} as never);
  vi.mocked(db.getWorkspaceStatus).mockResolvedValue({
    installed: true,
    botUserId: "U123",
    scopes: ["channels:history"],
    tokenRotationStatus: "ready",
    botTokenExpiresAt: new Date().toISOString(),
    lastTokenRefreshAt: new Date().toISOString(),
    lastTokenRefreshError: null,
    lastTokenRefreshErrorAt: null,
  } as never);
});

describe("Auth Routes", () => {
  it("stores refresh token and expiry metadata during install", async () => {
    const res = await request(createApp()).post("/api/auth/install").send({
      workspaceId: "T123",
      teamName: "Sage",
      botToken: "xoxb-access",
      refreshToken: "xoxe-refresh",
      expiresInSeconds: 3600,
      botUserId: "U123",
      installedBy: "U999",
      scopes: ["channels:history"],
    });

    expect(res.status).toBe(200);
    expect(db.upsertWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "T123",
        botUserId: "U123",
        installedBy: "U999",
        scopes: ["channels:history"],
        botRefreshTokenEncrypted: Buffer.from("xoxe-refresh", "utf8"),
      }),
    );
    expect(boss.enqueueChannelDiscovery).toHaveBeenCalledWith("T123", "install");
  });

  it("returns token rotation state from workspace status", async () => {
    const res = await request(createApp()).get(
      "/api/auth/workspace-status?workspace_id=T123",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        installed: true,
        tokenRotationStatus: "ready",
      }),
    );
  });
});
