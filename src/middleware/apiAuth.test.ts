import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mutable config for testing different scenarios
const mockConfig: Record<string, unknown> = {
  API_AUTH_TOKEN: "test-secret-token",
  NODE_ENV: "development",
  SUPABASE_JWT_SECRET: undefined,
};

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

vi.mock("../constants.js", () => ({
  DEFAULT_WORKSPACE: "default",
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

// Import after mocks are set up
const { requireApiAuth } = await import("./apiAuth.js");

function createMockReqRes(authHeader?: string, workspaceId?: string) {
  const req = {
    id: "test-request-id",
    get: vi.fn((name: string) => {
      if (name === "Authorization") return authHeader;
      return undefined;
    }),
    query: workspaceId ? { workspace_id: workspaceId } : {},
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe("requireApiAuth", () => {
  beforeEach(() => {
    mockConfig.API_AUTH_TOKEN = "test-secret-token";
    mockConfig.NODE_ENV = "development";
    mockConfig.SUPABASE_JWT_SECRET = undefined;
  });

  it("passes through with valid bearer token", async () => {
    const { req, res, next } = createMockReqRes("Bearer test-secret-token", "T123");
    await requireApiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects request without Authorization header", async () => {
    const { req, res, next } = createMockReqRes();
    await requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects request with invalid token", async () => {
    const { req, res, next } = createMockReqRes("Bearer wrong-token");
    await requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects non-Bearer auth scheme", async () => {
    const { req, res, next } = createMockReqRes("Basic dXNlcjpwYXNz");
    await requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("passes through in dev when no token configured", async () => {
    mockConfig.API_AUTH_TOKEN = undefined;
    const { req, res, next } = createMockReqRes(undefined, "T123");
    await requireApiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 500 in production when no token configured", async () => {
    mockConfig.API_AUTH_TOKEN = undefined;
    mockConfig.NODE_ENV = "production";
    const { req, res, next } = createMockReqRes();
    await requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("sets workspaceId from query param with static token", async () => {
    const { req, res, next } = createMockReqRes("Bearer test-secret-token", "T_CUSTOM");
    await requireApiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.workspaceId).toBe("T_CUSTOM");
  });

  it("rejects static token requests without workspace_id", async () => {
    const { req, res, next } = createMockReqRes("Bearer test-secret-token");
    await requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
