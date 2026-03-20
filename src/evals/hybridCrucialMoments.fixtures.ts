import type { MessageCandidateKind, StateTransition, SurfacePriority } from "../services/messageTriage.js";

export interface HybridEvalFixture {
  id: string;
  description: string;
  text: string;
  threadTs?: string | null;
  expected: {
    candidateKind: MessageCandidateKind;
    surfacePriority: SurfacePriority;
    stateTransition: StateTransition | null;
    shouldRefreshThreadInsight: boolean;
  };
}

export const hybridEvalFixtures: HybridEvalFixture[] = [
  {
    id: "routine-troubleshooting-confirmation",
    description: "Neutral troubleshooting confirmation should stay context-only, not anger.",
    text: "thats the problem i am getting",
    threadTs: "123.456",
    expected: {
      candidateKind: "context_only",
      surfacePriority: "low",
      stateTransition: null,
      shouldRefreshThreadInsight: false,
    },
  },
  {
    id: "external-dependency-blocker",
    description: "Explicit blocker waiting on vendor should be surfaced as external waiting.",
    text: "I'm blocked until the vendor rotates the API key, so I can't proceed.",
    threadTs: "123.456",
    expected: {
      candidateKind: "message_candidate",
      surfacePriority: "high",
      stateTransition: "waiting_external",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "direct-escalation",
    description: "Clear frustration and escalation language should trigger deep analysis.",
    text: "This is unacceptable, we need to escalate immediately.",
    threadTs: "123.456",
    expected: {
      candidateKind: "message_candidate",
      surfacePriority: "high",
      stateTransition: "escalated",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "acknowledgement-filler",
    description: "Short Hinglish acknowledgements should be ignored.",
    text: "haan",
    threadTs: "123.456",
    expected: {
      candidateKind: "ignore",
      surfacePriority: "none",
      stateTransition: null,
      shouldRefreshThreadInsight: false,
    },
  },
  {
    id: "resolution-signal",
    description: "Clear resolution should refresh thread insight without deep message analysis.",
    text: "Fixed now, you can proceed.",
    threadTs: "123.456",
    expected: {
      candidateKind: "resolution_signal",
      surfacePriority: "medium",
      stateTransition: "resolved",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "ownership-diagnosis-turning-point",
    description: "Diagnosis plus new instruction should be treated as a thread turning point.",
    text: "Use this account instead, the domain change caused the old login to fail.",
    threadTs: "123.456",
    expected: {
      candidateKind: "thread_turning_point",
      surfacePriority: "medium",
      stateTransition: "investigating",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "technical-question",
    description: "A concrete technical ask should stay operational, not emotional.",
    text: "@here on what account we have mixpanel for sage?",
    threadTs: "123.456",
    expected: {
      candidateKind: "message_candidate",
      surfacePriority: "medium",
      stateTransition: "issue_opened",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "log-context",
    description: "Pasted technical error context without an ask should remain low-signal context.",
    text: "this is the error: TypeError undefined is not a function",
    threadTs: "123.456",
    expected: {
      candidateKind: "context_only",
      surfacePriority: "low",
      stateTransition: null,
      shouldRefreshThreadInsight: false,
    },
  },
  {
    id: "ownership-assignment",
    description: "Ownership changes should become turning points.",
    text: "I'll handle the client reply and post an update here.",
    threadTs: "123.456",
    expected: {
      candidateKind: "thread_turning_point",
      surfacePriority: "medium",
      stateTransition: "ownership_assigned",
      shouldRefreshThreadInsight: true,
    },
  },
  {
    id: "duplicate-symptom",
    description: "Duplicate low-signal confirmations should not be promoted to anger or blocker.",
    text: "same issue on my side too",
    threadTs: "123.456",
    expected: {
      candidateKind: "context_only",
      surfacePriority: "low",
      stateTransition: null,
      shouldRefreshThreadInsight: false,
    },
  },
];
