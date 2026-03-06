import { describe, it, expect } from "vitest";
import { computeRiskScore } from "./riskHeuristic.js";

describe("computeRiskScore", () => {
  it("returns 0 for empty text", () => {
    expect(computeRiskScore("")).toBe(0);
    expect(computeRiskScore("   ")).toBe(0);
  });

  it("returns 0 for neutral text with no risk signals", () => {
    expect(computeRiskScore("Sounds good, thanks for the update")).toBe(0);
  });

  it("scores 0.3 for a single risk keyword", () => {
    expect(computeRiskScore("I am very frustrated with this")).toBeCloseTo(0.3);
  });

  it("scores 0.6 for two risk keywords", () => {
    expect(computeRiskScore("This is terrible and unacceptable")).toBeCloseTo(0.6);
  });

  it("caps keyword score at 3 matches (0.9)", () => {
    const text = "I am furious, this is terrible, unacceptable, and ridiculous";
    // 4 keywords but capped at 3 * 0.3 = 0.9
    expect(computeRiskScore(text)).toBeCloseTo(0.9);
  });

  it("adds 0.2 for ALL CAPS sentences", () => {
    expect(computeRiskScore("THIS IS COMPLETELY WRONG. okay fine.")).toBeCloseTo(0.2);
  });

  it("adds 0.15 for excessive exclamation marks", () => {
    expect(computeRiskScore("No way!!!")).toBeCloseTo(0.15);
  });

  it("adds 0.15 for excessive question marks", () => {
    expect(computeRiskScore("Are you serious???")).toBeCloseTo(0.15);
  });

  it("combines keyword + caps + punctuation scores", () => {
    // "angry" = 0.3, "!!!" = 0.15, CAPS sentence "THIS IS RIDICULOUS" = 0.2 + "ridiculous" = another 0.3
    const text = "I am angry. THIS IS RIDICULOUS!!!";
    const score = computeRiskScore(text);
    // angry(0.3) + ridiculous(0.3) + caps(0.2) + !!!(0.15) = 0.95
    expect(score).toBeCloseTo(0.95);
  });

  it("caps total score at 1.0", () => {
    // 3+ keywords (0.9) + caps (0.2) + !!! (0.15) + ??? (0.15) = 1.4 → capped at 1.0
    const text = "I am FURIOUS AND OUTRAGED!!! THIS IS TERRIBLE??? Absolutely ridiculous";
    expect(computeRiskScore(text)).toBe(1.0);
  });

  it("detects multi-word risk phrases", () => {
    expect(computeRiskScore("This is a waste of time")).toBeCloseTo(0.3);
    expect(computeRiskScore("I am fed up with this")).toBeCloseTo(0.3);
  });

  it("ignores short ALL CAPS segments (≤5 chars)", () => {
    // "OK" and "NO" are ≤5 chars, should not trigger caps bonus
    expect(computeRiskScore("OK. NO. Fine.")).toBe(0);
  });

  // ─── Sarcasm-suspect pattern tests ──────────────────────────────────────────

  it("scores 0.25 for positive word + negative context combo", () => {
    // "great" (positive) + "failed" (negative context) = 0.25
    expect(computeRiskScore("Great, the deployment failed again")).toBeCloseTo(0.25);
  });

  it("scores for ellipsis after positive word", () => {
    // "wonderful" (positive) + ellipsis = 0.15
    expect(computeRiskScore("wonderful...")).toBeCloseTo(0.15);
  });

  it("scores for quoted praise", () => {
    // "nice" in quotes = 0.15
    expect(computeRiskScore('"nice" work on that release')).toBeCloseTo(0.15);
  });

  it("scores for strikethrough markers", () => {
    // strikethrough = 0.1
    expect(computeRiskScore("This is [strikethrough: a great idea]")).toBeCloseTo(0.1);
  });

  it("combines sarcasm patterns with other signals", () => {
    // "fantastic" + "again" = 0.25 (positive+negative), "fantastic..." = 0.15 (ellipsis)
    const text = "Oh fantastic... the system crashed again";
    const score = computeRiskScore(text);
    // 0.25 + 0.15 = 0.40
    expect(score).toBeCloseTo(0.4);
  });

  it("does not trigger sarcasm for positive word alone without negative context", () => {
    expect(computeRiskScore("Great work on the release!")).toBe(0);
  });
});
