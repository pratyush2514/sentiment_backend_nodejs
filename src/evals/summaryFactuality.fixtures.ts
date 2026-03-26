interface EvidenceFactFixture {
  text: string;
  evidence_ts: string[];
}

export interface ChannelSummaryFactualityFixture {
  id: string;
  description: string;
  allowedTs: string[];
  topics: EvidenceFactFixture[];
  blockers: EvidenceFactFixture[];
  resolutions: EvidenceFactFixture[];
  decisions: EvidenceFactFixture[];
  fallbackSummary?: string;
  expected: {
    topics: string[];
    blockers: string[];
    resolutions: string[];
    decisions: string[];
    summaryIncludes: string[];
    summaryExcludes?: string[];
  };
}

export interface ThreadSummaryFactualityFixture {
  id: string;
  description: string;
  input: {
    primaryIssue: string;
    threadState: "monitoring" | "investigating" | "blocked" | "waiting_external" | "resolved" | "escalated";
    operationalRisk: "none" | "low" | "medium" | "high";
    openQuestions: string[];
    decisions: string[];
  };
  expected: {
    summaryIncludes: string[];
  };
}

export const channelSummaryFactualityFixtures: ChannelSummaryFactualityFixture[] = [
  {
    id: "drops-unsupported-blocker",
    description: "Unsupported blocker facts must not survive into the visible summary.",
    allowedTs: ["1.1", "1.2", "1.3", "1.4"],
    topics: [
      { text: "finalizing the script generator rollout", evidence_ts: ["1.1"] },
    ],
    blockers: [
      { text: "script generation is delayed in production", evidence_ts: ["1.2"] },
      { text: "customer is threatening churn", evidence_ts: ["missing-ts"] },
    ],
    resolutions: [
      { text: "thumbnail generation was fixed for most platforms", evidence_ts: ["1.3"] },
    ],
    decisions: [
      { text: "Rushil will share the RCA and Sidd will review it", evidence_ts: ["1.4"] },
    ],
    expected: {
      topics: ["finalizing the script generator rollout"],
      blockers: ["script generation is delayed in production"],
      resolutions: ["thumbnail generation was fixed for most platforms"],
      decisions: ["Rushil will share the RCA and Sidd will review it"],
      summaryIncludes: [
        "Over the last 7 days, the channel centered on finalizing the script generator rollout.",
        "The main active blockers or risks were script generation is delayed in production.",
        "Progress during the same window included thumbnail generation was fixed for most platforms.",
      ],
      summaryExcludes: ["customer is threatening churn"],
    },
  },
  {
    id: "falls-back-cleanly",
    description: "When nothing is supported, the summary should fall back cleanly instead of inventing risk.",
    allowedTs: ["2.1"],
    topics: [],
    blockers: [{ text: "unverified outage", evidence_ts: ["missing-ts"] }],
    resolutions: [],
    decisions: [],
    fallbackSummary: "Existing summary still applies.",
    expected: {
      topics: [],
      blockers: [],
      resolutions: [],
      decisions: [],
      summaryIncludes: ["Existing summary still applies."],
    },
  },
];

export const threadSummaryFactualityFixtures: ThreadSummaryFactualityFixture[] = [
  {
    id: "blocked-thread-summary",
    description: "Thread summaries should render from structured facts instead of freeform inference.",
    input: {
      primaryIssue: "video edit credits are failing for paid users",
      threadState: "blocked",
      operationalRisk: "medium",
      openQuestions: ["which plan should the error message point to"],
      decisions: ["Nick will verify the account credits configuration"],
    },
    expected: {
      summaryIncludes: [
        "Primary issue: video edit credits are failing for paid users.",
        "The thread is currently blocked and needs follow-through.",
        "Operational risk remains medium.",
        "Key decisions or actions: Nick will verify the account credits configuration.",
      ],
    },
  },
];
