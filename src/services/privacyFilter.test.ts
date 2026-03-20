import { describe, it, expect, vi } from "vitest";
import {
  detectSensitiveContent,
  redactSensitiveContent,
  sanitizeForExternalUse,
} from "./privacyFilter.js";

vi.mock("../config.js", () => ({
  config: { PRIVACY_MODE: "redact" },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ─── Detection: API Keys ────────────────────────────────────────────────────

describe("detectSensitiveContent", () => {
  describe("api_key", () => {
    it("detects OpenAI sk- keys", () => {
      const result = detectSensitiveContent("my key is sk-abc123def456ghi789jkl012mno345");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "api_key")).toBe(true);
    });

    it("detects Slack xoxb- tokens", () => {
      const result = detectSensitiveContent("token: xoxb-123456789012-abcdefghij");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "api_key")).toBe(true);
    });

    it("detects GitHub ghp_ tokens", () => {
      const result = detectSensitiveContent("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "api_key")).toBe(true);
    });

    it("detects AWS AKIA keys", () => {
      const result = detectSensitiveContent("AKIAIOSFODNN7EXAMPLE");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "api_key")).toBe(true);
    });

    it("does not flag short sk- strings", () => {
      const result = detectSensitiveContent("sk-short");
      expect(result.matches.some((m) => m.category === "api_key")).toBe(false);
    });
  });

  // ─── Detection: JWT ─────────────────────────────────────────────────────

  describe("jwt", () => {
    it("detects JWT tokens", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const result = detectSensitiveContent(`Bearer ${jwt}`);
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "jwt")).toBe(true);
    });

    it("does not flag partial eyJ strings", () => {
      const result = detectSensitiveContent("eyJhbGci is a header prefix");
      expect(result.matches.some((m) => m.category === "jwt")).toBe(false);
    });
  });

  // ─── Detection: Email ───────────────────────────────────────────────────

  describe("email", () => {
    it("detects standard email addresses", () => {
      const result = detectSensitiveContent("contact me at user@company.com");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "email")).toBe(true);
    });

    it("detects emails with plus tags", () => {
      const result = detectSensitiveContent("test.name+tag@domain.co.uk");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "email")).toBe(true);
    });
  });

  // ─── Detection: Phone ──────────────────────────────────────────────────

  describe("phone", () => {
    it("detects US phone numbers with parens", () => {
      const result = detectSensitiveContent("call (555) 123-4567");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "phone")).toBe(true);
    });

    it("detects phone with country code", () => {
      const result = detectSensitiveContent("reach me at +1-555-123-4567");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "phone")).toBe(true);
    });
  });

  // ─── Detection: Credit Card ─────────────────────────────────────────────

  describe("credit_card", () => {
    it("detects Visa card numbers", () => {
      const result = detectSensitiveContent("my card is 4111111111111111");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "credit_card")).toBe(true);
    });

    it("detects Amex card numbers", () => {
      const result = detectSensitiveContent("amex: 378282246310005");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "credit_card")).toBe(true);
    });
  });

  // ─── Detection: IP Address ──────────────────────────────────────────────

  describe("ip_address", () => {
    it("detects public IP addresses", () => {
      const result = detectSensitiveContent("server at 54.23.100.5");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "ip_address")).toBe(true);
    });

    it("excludes private IPs (127.0.0.1)", () => {
      const result = detectSensitiveContent("localhost is 127.0.0.1");
      expect(result.matches.some((m) => m.category === "ip_address")).toBe(false);
    });

    it("excludes private IPs (10.x)", () => {
      const result = detectSensitiveContent("internal: 10.0.0.1");
      expect(result.matches.some((m) => m.category === "ip_address")).toBe(false);
    });

    it("excludes private IPs (192.168.x)", () => {
      const result = detectSensitiveContent("router: 192.168.1.1");
      expect(result.matches.some((m) => m.category === "ip_address")).toBe(false);
    });
  });

  // ─── Detection: Base64 / Hex Blobs ──────────────────────────────────────

  describe("base64_blob", () => {
    it("detects long base64 strings (40+ chars)", () => {
      const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop==";
      const result = detectSensitiveContent(`encoded: ${b64}`);
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "base64_blob")).toBe(true);
    });

    it("does not flag short base64 strings", () => {
      const result = detectSensitiveContent("short base64: YWJj");
      expect(result.matches.some((m) => m.category === "base64_blob")).toBe(false);
    });
  });

  describe("hex_blob", () => {
    it("detects long hex strings (SHA256 hashes)", () => {
      const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      const result = detectSensitiveContent(`hash: ${hash}`);
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "hex_blob")).toBe(true);
    });

    it("does not flag short hex like color codes", () => {
      const result = detectSensitiveContent("color: #FF5733");
      expect(result.matches.some((m) => m.category === "hex_blob")).toBe(false);
    });
  });

  // ─── Detection: Password Patterns ───────────────────────────────────────

  describe("password", () => {
    it("detects password= assignments", () => {
      const result = detectSensitiveContent("password=hunter2");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "password")).toBe(true);
    });

    it("detects secret: assignments", () => {
      const result = detectSensitiveContent("secret: my_super_secret_value");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "password")).toBe(true);
    });

    it("detects api_key= assignments", () => {
      const result = detectSensitiveContent("api_key=sk-12345abcde");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "password")).toBe(true);
    });
  });

  // ─── Detection: Private URLs ────────────────────────────────────────────

  describe("private_url", () => {
    it("detects internal URLs", () => {
      const result = detectSensitiveContent("check https://api.internal.corp:8080/path");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "private_url")).toBe(true);
    });

    it("detects localhost URLs", () => {
      const result = detectSensitiveContent("running on http://localhost:3000/api");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "private_url")).toBe(true);
    });

    it("detects staging URLs", () => {
      const result = detectSensitiveContent("deploy to https://app.staging.example.com");
      expect(result.hasSensitiveContent).toBe(true);
      expect(result.matches.some((m) => m.category === "private_url")).toBe(true);
    });
  });

  // ─── Detection: False Positives ─────────────────────────────────────────

  describe("false positives", () => {
    it("does not flag normal conversation", () => {
      const result = detectSensitiveContent("Hey team, the sprint review went well today");
      expect(result.hasSensitiveContent).toBe(false);
      expect(result.score).toBe(0);
    });

    it("does not flag normal sentences with numbers", () => {
      const result = detectSensitiveContent("We had 42 tickets this sprint and closed 35");
      expect(result.hasSensitiveContent).toBe(false);
    });

    it("returns empty result for empty string", () => {
      const result = detectSensitiveContent("");
      expect(result.hasSensitiveContent).toBe(false);
      expect(result.matches).toHaveLength(0);
    });
  });

  // ─── Score Calculation ──────────────────────────────────────────────────

  describe("scoring", () => {
    it("scores per unique category, not per match", () => {
      const result = detectSensitiveContent("user@a.com and user@b.com");
      // Two email matches but only one category — should score 0.2, not 0.4
      expect(result.score).toBe(0.2);
    });

    it("caps score at 1.0", () => {
      const text = "sk-abc123def456ghi789jkl012mno345 password=hunter2 user@test.com 4111111111111111";
      const result = detectSensitiveContent(text);
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });
});

// ─── Redaction ──────────────────────────────────────────────────────────────

describe("redactSensitiveContent", () => {
  it("replaces matched span with a neutral placeholder", () => {
    const text = "my key is sk-abc123def456ghi789jkl012mno345 and thats it";
    const detection = detectSensitiveContent(text);
    const redacted = redactSensitiveContent(text, detection.matches);
    expect(redacted).not.toContain("sk-abc123");
    expect(redacted).toContain("my key is ");
    expect(redacted).toContain(" and thats it");
  });

  it("handles multiple non-overlapping matches", () => {
    const text = "email user@test.com and call (555) 123-4567";
    const detection = detectSensitiveContent(text);
    const redacted = redactSensitiveContent(text, detection.matches);
    expect(redacted).not.toContain("user@test.com");
    expect(redacted).not.toContain("(555) 123-4567");
    expect(redacted).toContain("email ");
    expect(redacted).toContain(" and call ");
  });

  it("returns original text when no matches", () => {
    const text = "nothing sensitive here";
    const result = redactSensitiveContent(text, []);
    expect(result).toBe(text);
  });

  it("merges overlapping matches", () => {
    // password= pattern may overlap with api_key pattern
    const text = "api_key=sk-abc123def456ghi789jkl012mno345";
    const detection = detectSensitiveContent(text);
    const redacted = redactSensitiveContent(text, detection.matches);
    expect(redacted).not.toContain("api_key=");
    expect(redacted).not.toContain("sk-abc123");
  });
});

// ─── Gateway: sanitizeForExternalUse ────────────────────────────────────────

describe("sanitizeForExternalUse", () => {
  it("passes through when mode is off", () => {
    const text = "password=hunter2";
    const result = sanitizeForExternalUse(text, "off");
    expect(result.action).toBe("passthrough");
    expect(result).toHaveProperty("text", text);
  });

  it("passes through when no sensitive content found", () => {
    const text = "just a normal message";
    const result = sanitizeForExternalUse(text, "redact");
    expect(result.action).toBe("passthrough");
    expect(result).toHaveProperty("text", text);
  });

  it("redacts when mode is redact and sensitive content found", () => {
    const text = "my key is sk-abc123def456ghi789jkl012mno345";
    const result = sanitizeForExternalUse(text, "redact");
    expect(result.action).toBe("redacted");
    if (result.action === "redacted") {
      expect(result.text).not.toContain("sk-abc123");
      expect(result.redactedCount).toBeGreaterThan(0);
    }
  });

  it("skips when mode is skip and sensitive content found", () => {
    const text = "my key is sk-abc123def456ghi789jkl012mno345";
    const result = sanitizeForExternalUse(text, "skip");
    expect(result.action).toBe("skipped");
  });

  it("uses config default when no mode specified", () => {
    // Config mock has PRIVACY_MODE = "redact"
    const text = "user@example.com is my email";
    const result = sanitizeForExternalUse(text);
    expect(result.action).toBe("redacted");
  });
});
