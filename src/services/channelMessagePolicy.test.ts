import { describe, expect, it, vi } from "vitest";
import { allowsAutomatedMessageIngestion } from "./channelMessagePolicy.js";

vi.mock("../config.js", () => ({
  config: {
    AUTOMATION_CHANNEL_KEYWORDS: [
      "error",
      "errors",
      "alert",
      "alerts",
      "incident",
      "incidents",
      "monitor",
      "monitoring",
      "n8n",
    ],
  },
}));

describe("allowsAutomatedMessageIngestion", () => {
  it("allows automation-style error channels", () => {
    expect(allowsAutomatedMessageIngestion("sage_n8n_errors")).toBe(true);
    expect(allowsAutomatedMessageIngestion("#ops-alerts")).toBe(true);
  });

  it("does not treat normal collaboration channels as automation channels", () => {
    expect(allowsAutomatedMessageIngestion("sage_team")).toBe(false);
    expect(allowsAutomatedMessageIngestion("channel-sentiment")).toBe(false);
  });
});
