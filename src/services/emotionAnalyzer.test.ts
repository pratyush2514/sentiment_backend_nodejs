import { describe, expect, it } from "vitest";
import { calibrateMessageAnalysis, type MessageAnalysis } from "./emotionAnalyzer.js";

function makeAnalysis(overrides: Partial<MessageAnalysis> = {}): MessageAnalysis {
  return {
    dominant_emotion: "neutral",
    interaction_tone: "neutral",
    confidence: 0.7,
    escalation_risk: "low",
    sarcasm_detected: false,
    explanation: "Test explanation",
    trigger_phrases: [],
    message_intent: "fyi",
    is_actionable: false,
    is_blocking: false,
    urgency_level: "none",
    ...overrides,
  };
}

describe("calibrateMessageAnalysis", () => {
  it("downgrades sharp corrective feedback from anger to neutral", () => {
    const calibrated = calibrateMessageAnalysis(
      makeAnalysis({
        dominant_emotion: "anger",
        interaction_tone: "corrective",
        confidence: 0.9,
        escalation_risk: "medium",
      }),
      "yes, please read the diagram before sending",
    );

    expect(calibrated.dominant_emotion).toBe("neutral");
    expect(calibrated.interaction_tone).toBe("corrective");
    expect(calibrated.confidence).toBeLessThanOrEqual(0.74);
    expect(calibrated.explanation).toContain("corrective feedback");
  });

  it("keeps true hostile anger intact", () => {
    const calibrated = calibrateMessageAnalysis(
      makeAnalysis({
        dominant_emotion: "anger",
        interaction_tone: "confrontational",
        confidence: 0.92,
        escalation_risk: "high",
      }),
      "this is ridiculous, stop doing this",
    );

    expect(calibrated.dominant_emotion).toBe("anger");
    expect(calibrated.interaction_tone).toBe("confrontational");
    expect(calibrated.confidence).toBe(0.92);
  });
});
