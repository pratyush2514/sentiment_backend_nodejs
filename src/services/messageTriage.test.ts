import { describe, expect, it } from "vitest";
import { classifyMessageTriage, isDeepAnalysisCandidate, shouldRefreshThreadInsight } from "./messageTriage.js";

describe("classifyMessageTriage", () => {
  it("classifies routine troubleshooting confirmations as context only", () => {
    const result = classifyMessageTriage({
      text: "thats the problem i am getting",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("context_only");
    expect(result.surfacePriority).toBe("low");
    expect(result.reasonCodes).toContain("routine_troubleshooting");
  });

  it("classifies explicit blockers as message candidates", () => {
    const result = classifyMessageTriage({
      text: "I'm blocked until the vendor rotates the API key, so I can't proceed.",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("message_candidate");
    expect(result.stateTransition).toBe("waiting_external");
    expect(result.surfacePriority).toBe("high");
  });

  it("classifies acknowledgments as ignore", () => {
    const result = classifyMessageTriage({
      text: "haan",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("ignore");
    expect(result.surfacePriority).toBe("none");
  });

  it("classifies resolution signals separately", () => {
    const result = classifyMessageTriage({
      text: "Fixed now, you can proceed.",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("resolution_signal");
    expect(result.stateTransition).toBe("resolved");
    expect(shouldRefreshThreadInsight(result, "123.456")).toBe(true);
  });

  it("classifies ownership and diagnosis updates as thread turning points", () => {
    const result = classifyMessageTriage({
      text: "Use this account instead, the domain change caused the old login to fail.",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("thread_turning_point");
    expect(result.surfacePriority).toBe("medium");
  });

  it("flags anger and escalation as deep-analysis candidates", () => {
    const result = classifyMessageTriage({
      text: "This is unacceptable, we need to escalate immediately.",
    });

    expect(result.candidateKind).toBe("message_candidate");
    expect(isDeepAnalysisCandidate(result.candidateKind)).toBe(true);
    expect(result.stateTransition).toBe("escalated");
  });

  it("does not refresh thread insight for ordinary medium-priority issue-opening questions", () => {
    const result = classifyMessageTriage({
      text: "Can someone check why Mixpanel access is failing for Sage?",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("message_candidate");
    expect(result.surfacePriority).toBe("medium");
    expect(result.stateTransition).toBe("issue_opened");
    expect(shouldRefreshThreadInsight(result, "123.456")).toBe(false);
  });

  it("keeps benign coordination questions as context only", () => {
    const result = classifyMessageTriage({
      text: "what account do we have mixpanel for sage?",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("context_only");
    expect(result.surfacePriority).toBe("none");
    expect(result.stateTransition).toBe(null);
  });

  it("promotes contrast-heavy mixed messages when the later clause indicates breakage", () => {
    const result = classifyMessageTriage({
      text: "okay thanks we will do that surely, but right now something is breaking so we need to fix that as well",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("message_candidate");
    expect(result.surfacePriority).toBe("medium");
    expect(result.stateTransition).toBe("investigating");
    expect(result.reasonCodes).toContain("contrast_focus");
    expect(result.reasonCodes).toContain("breakage_signal");
    expect(result.reasonCodes).toContain("action_required_signal");
  });

  it("keeps polite commitment messages as context when they do not include risk signals", () => {
    const result = classifyMessageTriage({
      text: "okay thanks we will do that surely",
      threadTs: "123.456",
    });

    expect(result.candidateKind).toBe("context_only");
    expect(result.surfacePriority).toBe("none");
    expect(result.stateTransition).toBe(null);
  });

  it("treats referenced external incidents as related context instead of local operational incidents", () => {
    const result = classifyMessageTriage({
      text: "We are blocked in sage_team because #sage_n8n_errors is throwing a Workflow Error again.",
      threadTs: "123.456",
      channelMode: "collaboration",
      channelName: "sage_team",
      originType: "human",
    });

    expect(result.candidateKind).toBe("message_candidate");
    expect(result.signalType).toBe("human_risk");
    expect(result.incidentFamily).toBe("none");
    expect(result.reasonCodes).toContain("related_external_incident");
    expect(result.signals.relatedIncidentKind).toBe("referenced_external_incident");
    expect(result.signals.relatedIncidentSourceChannelName).toBe("sage_n8n_errors");
    expect(result.signals.relatedIncidentBlocksLocalWork).toBe(true);
  });
});
