import { describe, expect, it } from "vitest";
import {
  deriveThreadSurfacePriority,
  isManagerRelevantThreadInsight,
  normalizeCrucialMoments,
} from "./threadInsightPolicy.js";

describe("threadInsightPolicy", () => {
  it("downgrades generic issue-opened moments so they are not surfaced", () => {
    const moments = normalizeCrucialMoments([
      {
        messageTs: "1710000000.000100",
        kind: "issue_opened",
        reason: "This message introduced the issue that drives the thread.",
        surfacePriority: "medium",
      },
    ]);

    expect(moments).toEqual([
      expect.objectContaining({
        surfacePriority: "none",
      }),
    ]);
  });

  it("suppresses resolved calm low-risk threads even if the model marked them medium", () => {
    const surfacePriority = deriveThreadSurfacePriority({
      threadState: "resolved",
      operationalRisk: "none",
      emotionalTemperature: "calm",
      surfacePriority: "medium",
      openQuestions: [],
      crucialMoments: [
        {
          messageTs: "1710000000.000100",
          kind: "issue_opened",
          reason: "This message introduced the issue that drives the thread.",
          surfacePriority: "medium",
        },
      ],
    });

    expect(surfacePriority).toBe("none");
    expect(
      isManagerRelevantThreadInsight({
        threadState: "resolved",
        operationalRisk: "none",
        emotionalTemperature: "calm",
        surfacePriority,
        openQuestions: [],
        crucialMoments: [],
      }),
    ).toBe(false);
  });

  it("keeps blocked or risky threads surfaced", () => {
    expect(
      isManagerRelevantThreadInsight({
        threadState: "blocked",
        operationalRisk: "medium",
        emotionalTemperature: "watch",
        surfacePriority: "medium",
        openQuestions: ["Who owns the unblock?"],
        crucialMoments: [],
      }),
    ).toBe(true);
  });
});
