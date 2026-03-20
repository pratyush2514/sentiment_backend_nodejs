const PLACEHOLDER_SUMMARY_PATTERNS = [
  /^Backfilled \d+ human messages\./i,
  /^No summary yet\b/i,
];

export function isPlaceholderSummary(summary: string | null | undefined): boolean {
  const normalized = summary?.trim();
  if (!normalized) {
    return true;
  }

  return PLACEHOLDER_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeSummaryForLLM(summary: string | null | undefined): string {
  const normalized = summary?.trim() ?? "";
  if (!normalized || isPlaceholderSummary(normalized)) {
    return "";
  }

  return normalized;
}

export function buildFallbackChannelSummary(input: {
  totalMessages: number;  
  participantCount: number;
  topParticipants: string[];
  threadCount: number;
  recentSnippets: string[];
}): string {
  const participantText =
    input.participantCount > 0
      ? `${input.participantCount} participant${input.participantCount === 1 ? "" : "s"}`
      : "no active participants yet";
  const topParticipantsText =
    input.topParticipants.length > 0
      ? `Most active: ${input.topParticipants.join(", ")}.`
      : "Participant activity is still being established.";
  const threadText =
    input.threadCount > 0
      ? `${input.threadCount} active thread${input.threadCount === 1 ? "" : "s"} currently shape the conversation.`
      : "No active sub-threads have emerged yet.";
  const recentText =
    input.recentSnippets.length > 0
      ? `Recent discussion touched on: ${input.recentSnippets.join(" | ")}.`
      : "Recent message excerpts are still being prepared.";

  return [
    `Conversation history covers ${input.totalMessages} messages across ${participantText}.`,
    topParticipantsText,
    threadText,
    recentText,
  ].join(" ");
}
