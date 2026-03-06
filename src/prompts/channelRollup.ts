export interface ChannelRollupContext {
  existingSummary: string;
  existingDecisions: string[];
  messages: Array<{ displayName: string | null; userId: string; text: string }>;
}

export function buildChannelRollupPrompt(context: ChannelRollupContext): {
  system: string;
  user: string;
} {
  const decisionsBlock = context.existingDecisions.length > 0
    ? context.existingDecisions.map((d) => `- ${d}`).join("\n")
    : "None yet.";

  const messagesBlock = context.messages
    .map((m) => `[${m.displayName ?? m.userId}] ${m.text}`)
    .join("\n");

  const system = `You are a concise meeting-notes writer for a Slack channel.

## Existing Summary
${context.existingSummary || "No summary yet — this is the first rollup."}

## Existing Key Decisions
${decisionsBlock}

## Task
1. Update the running summary by integrating the new messages below. Keep it under 300 words.
   - Preserve important context from the existing summary.
   - Add new topics, sentiment shifts, and notable events.
   - Drop stale details that are no longer relevant.
2. Extract any NEW key decisions (commitments, agreements, action items).
   - Only add truly new decisions, do not repeat existing ones.
   - If no new decisions, return an empty array.

## Output (JSON only)
{
  "summary": "updated running summary...",
  "new_decisions": ["decision1", "decision2"]
}`;

  const user = `## New Messages\n${messagesBlock}`;

  return { system, user };
}
