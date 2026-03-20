import { describe, expect, it } from "vitest";
import { scoreFollowUpText } from "./followUpMonitor.js";

describe("scoreFollowUpText", () => {
  it("does not create a reminder for neutral short chatter", () => {
    expect(scoreFollowUpText("ok")).toMatchObject({
      shouldTrack: false,
      seriousnessScore: 0,
    });
  });

  it("does not track soft acknowledgments or casual sign-offs", () => {
    expect(scoreFollowUpText("thanks")).toMatchObject({
      shouldTrack: false,
      seriousnessScore: 0,
    });

    expect(scoreFollowUpText("got it")).toMatchObject({
      shouldTrack: false,
      seriousnessScore: 0,
    });
  });

  it("tracks short explicit asks", () => {
    const result = scoreFollowUpText("here?");
    expect(result.shouldTrack).toBe(true);
    expect(result.reasonCodes).toContain("explicit_question");
  });

  it("does not escalate casual mentions without an action signal", () => {
    const result = scoreFollowUpText("hey team");
    expect(result.shouldTrack).toBe(false);
    expect(result.reasonCodes).toContain("direct_address");
    expect(result.seriousnessScore).toBe(1);
  });

  it("tracks short direct nudges and mention questions", () => {
    expect(scoreFollowUpText("guys??")).toMatchObject({
      shouldTrack: true,
    });
    expect(scoreFollowUpText("<@U0AJB4NU4DP> ?")).toMatchObject({
      shouldTrack: true,
    });
  });

  it("tracks explicit requests", () => {
    const result = scoreFollowUpText("Can you send the latest status update?");
    expect(result.shouldTrack).toBe(true);
    expect(result.reasonCodes).toContain("request_language");
  });

  it("escalates repeated follow-up nudges", () => {
    const result = scoreFollowUpText("Following up again, any update on this?", 3);
    expect(result.shouldTrack).toBe(true);
    expect(result.reasonCodes).toContain("follow_up_language");
    expect(result.reasonCodes).toContain("repeated_ask");
    expect(result.seriousness).toBe("high");
    expect(result.summary).toContain("3 repeated nudges");
  });

  it("raises urgency when time pressure is explicit", () => {
    const result = scoreFollowUpText("This is urgent, please review ASAP.");
    expect(result.shouldTrack).toBe(true);
    expect(result.reasonCodes).toContain("urgency_language");
    expect(result.seriousnessScore).toBeGreaterThanOrEqual(5);
  });

  it("does not treat completion updates as follow-up requests", () => {
    expect(
      scoreFollowUpText(
        "Congratulations sir everything is working fine now and no need to worry about it.",
      ),
    ).toMatchObject({
      shouldTrack: false,
      seriousnessScore: 0,
    });
  });

  it("does not track resolved status messages that merely contain the word need", () => {
    expect(
      scoreFollowUpText("It is all working now, no need to worry."),
    ).toMatchObject({
      shouldTrack: false,
      seriousnessScore: 0,
    });
  });
});
