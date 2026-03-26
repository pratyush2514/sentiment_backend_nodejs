import { describe, expect, it } from "vitest";
import {
  buildChannelSummaryFromFacts,
  buildThreadSummary,
  filterSupportedEvidenceFacts,
} from "./summarizer.js";

describe("filterSupportedEvidenceFacts", () => {
  it("keeps only evidence-backed facts and deduplicates by normalized text", () => {
    const facts = filterSupportedEvidenceFacts(
      [
        { text: " Script generation is delayed ", evidence_ts: ["1.1"] },
        { text: "Script generation is delayed", evidence_ts: ["1.1"] },
        { text: "Supabase incident is affecting throughput", evidence_ts: ["missing"] },
        { text: "Client demo is tomorrow", evidence_ts: ["1.2", "1.3"] },
      ],
      new Set(["1.1", "1.2", "1.3"]),
      5,
    );

    expect(facts).toEqual([
      { text: "Script generation is delayed", evidence_ts: ["1.1"] },
      { text: "Client demo is tomorrow", evidence_ts: ["1.2", "1.3"] },
    ]);
  });
});

describe("buildChannelSummaryFromFacts", () => {
  it("renders a concise summary from supported facts only", () => {
    const summary = buildChannelSummaryFromFacts({
      topics: [{ text: "finalizing the script generator rollout", evidence_ts: ["1.1"] }],
      blockers: [{ text: "script generation is delayed in production", evidence_ts: ["1.2"] }],
      resolutions: [{ text: "thumbnail generation was fixed for most platforms", evidence_ts: ["1.3"] }],
      decisions: [{ text: "Rushil will share the RCA and Sidd will review it", evidence_ts: ["1.4"] }],
    });

    expect(summary).toContain("Over the last 7 days, key discussions included: finalizing the script generator rollout.");
    expect(summary).toContain("Active blockers or risks: script generation is delayed in production.");
    expect(summary).toContain("Recent progress: thumbnail generation was fixed for most platforms.");
    expect(summary).toContain("Key decisions and next steps: Rushil will share the RCA and Sidd will review it.");
  });

  it("falls back cleanly when no supported facts survive", () => {
    const summary = buildChannelSummaryFromFacts({
      topics: [],
      blockers: [],
      resolutions: [],
      decisions: [],
      fallbackSummary: "Existing summary still applies.",
    });

    expect(summary).toBe("Existing summary still applies.");
  });

  it("renders live summaries as a short recent delta", () => {
    const summary = buildChannelSummaryFromFacts({
      topics: [{ text: "review of the referral system", evidence_ts: ["1.1"] }],
      blockers: [{ text: "merge approval is still pending", evidence_ts: ["1.2"] }],
      decisions: [{ text: "Rushil will confirm before merge", evidence_ts: ["1.3"] }],
      resolutions: [],
      style: "live",
    });

    expect(summary).toContain("Latest activity focused on review of the referral system.");
    expect(summary).toContain("New risk to watch: merge approval is still pending.");
    expect(summary).toContain("Immediate next steps: Rushil will confirm before merge.");
  });
});

describe("buildThreadSummary", () => {
  it("renders thread summaries from structured fields instead of freeform prose", () => {
    const summary = buildThreadSummary({
      primaryIssue: "video edit credits are failing for paid users",
      threadState: "blocked",
      operationalRisk: "medium",
      openQuestions: ["which plan should the error message point to"],
      decisions: ["Nick will verify the account credits configuration"],
    });

    expect(summary).toContain("Primary issue: video edit credits are failing for paid users.");
    expect(summary).toContain("The thread is currently blocked and needs follow-through.");
    expect(summary).toContain("Operational risk remains medium.");
    expect(summary).toContain("Key decisions or actions: Nick will verify the account credits configuration.");
    expect(summary).toContain("Open questions remain around which plan should the error message point to.");
  });
});
