import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidSlackSignature } from "./slackSignature.js";

// Mock the config module
vi.mock("../config.js", () => ({
  config: {
    SLACK_SIGNING_SECRET: "test_signing_secret_abc123",
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));

function createValidSignature(body: string, timestamp: string, secret: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", secret).update(baseString).digest("hex");
  return `v0=${hmac}`;
}

describe("isValidSlackSignature", () => {
  const secret = "test_signing_secret_abc123";
  let nowSeconds: number;

  beforeEach(() => {
    nowSeconds = Math.floor(Date.now() / 1000);
  });

  it("accepts a valid signature", () => {
    const body = '{"type":"event_callback"}';
    const timestamp = String(nowSeconds);
    const signature = createValidSignature(body, timestamp, secret);

    expect(isValidSlackSignature(body, timestamp, signature)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = '{"type":"event_callback"}';
    const timestamp = String(nowSeconds);

    expect(isValidSlackSignature(body, timestamp, "v0=invalid_hex")).toBe(false);
  });

  it("rejects an expired timestamp (older than 5 minutes)", () => {
    const body = '{"type":"event_callback"}';
    const staleTimestamp = String(nowSeconds - 301); // 5 min + 1 sec ago
    const signature = createValidSignature(body, staleTimestamp, secret);

    expect(isValidSlackSignature(body, staleTimestamp, signature)).toBe(false);
  });

  it("accepts a timestamp within the 5-minute window", () => {
    const body = '{"type":"event_callback"}';
    const recentTimestamp = String(nowSeconds - 120); // 2 min ago
    const signature = createValidSignature(body, recentTimestamp, secret);

    expect(isValidSlackSignature(body, recentTimestamp, signature)).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(isValidSlackSignature("body", "not-a-number", "v0=abc")).toBe(false);
  });

  it("rejects when body has been tampered with", () => {
    const body = '{"type":"event_callback"}';
    const timestamp = String(nowSeconds);
    const signature = createValidSignature(body, timestamp, secret);

    expect(isValidSlackSignature("tampered body", timestamp, signature)).toBe(false);
  });
});
