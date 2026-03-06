import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mutable config for testing different scenarios
const mockConfig = {
  API_AUTH_TOKEN: "test-secret-token",
  NODE_ENV: "development" as string,
};

vi.mock("../config.js", () => ({
  config: mockConfig,
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

function createMockReqRes(authHeader?: string) {
  const req = {
    id: "test-request-id",
    get: vi.fn((name: string) => {
      if (name === "Authorization") return authHeader;
      return undefined;
    }),
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
  });

  it("passes through with valid bearer token", () => {
    const { req, res, next } = createMockReqRes("Bearer test-secret-token");
    requireApiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects request without Authorization header", () => {
    const { req, res, next } = createMockReqRes();
    requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects request with invalid token", () => {
    const { req, res, next } = createMockReqRes("Bearer wrong-token");
    requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects non-Bearer auth scheme", () => {
    const { req, res, next } = createMockReqRes("Basic dXNlcjpwYXNz");
    requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("passes through in dev when no token configured", () => {
    mockConfig.API_AUTH_TOKEN = undefined as unknown as string;
    const { req, res, next } = createMockReqRes();
    requireApiAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 500 in production when no token configured", () => {
    mockConfig.API_AUTH_TOKEN = undefined as unknown as string;
    mockConfig.NODE_ENV = "production";
    const { req, res, next } = createMockReqRes();
    requireApiAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
