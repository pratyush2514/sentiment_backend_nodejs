import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    LOW_SIGNAL_CHANNEL_NAMES: ["general", "random", "social", "watercooler"],
  },
}));

const {
  deriveRecommendedImportanceTier,
  getRiskOnlyMonitoringNotice,
  resolveConversationImportance,
  resolveEffectiveImportanceTier,
} = await import("./conversationImportance.js");

describe("conversationImportance", () => {
  it("defaults client-tagged channels to high_value", () => {
    expect(
      deriveRecommendedImportanceTier({
        channelName: "sage_team",
        conversationType: "public_channel",
        clientUserIds: ["U-client"],
      }),
    ).toBe("high_value");
  });

  it("defaults low-signal public channels to low_value", () => {
    expect(
      deriveRecommendedImportanceTier({
        channelName: "#general",
        conversationType: "public_channel",
        clientUserIds: [],
      }),
    ).toBe("low_value");
  });

  it("uses standard for ordinary internal project channels", () => {
    expect(
      deriveRecommendedImportanceTier({
        channelName: "sage_team",
        conversationType: "public_channel",
        clientUserIds: [],
      }),
    ).toBe("standard");
  });

  it("lets manual override beat the recommendation", () => {
    const importance = resolveConversationImportance({
      channelName: "sage_team",
      conversationType: "public_channel",
      clientUserIds: ["U-client"],
      importanceTierOverride: "low_value",
    });

    expect(importance.recommendedImportanceTier).toBe("high_value");
    expect(importance.effectiveImportanceTier).toBe("low_value");
  });

  it("normalizes missing overrides to auto and resolves the effective tier", () => {
    expect(
      resolveEffectiveImportanceTier({
        channelName: "random",
        conversationType: "public_channel",
        clientUserIds: [],
      }),
    ).toBe("low_value");
  });

  it("returns an explicit risk-only notice for low-value channels", () => {
    expect(getRiskOnlyMonitoringNotice()).toContain("Risk-only monitoring is enabled");
  });
});
