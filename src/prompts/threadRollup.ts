export interface ThreadRollupContext {
  channelSummary: string;
  messages: Array<{ displayName: string | null; userId: string; text: string }>;
}

export function buildThreadRollupPrompt(context: ThreadRollupContext): {
  system: string;
  user: string;
} {
  const messagesBlock = context.messages
    .map((m) => `[${m.displayName ?? m.userId}] ${m.text}`)
    .join("\n");

  const system = `You are summarizing a Slack thread for future reference.

## Channel Context
${context.channelSummary || "No channel summary available."}

## Task
Write a concise 2-4 sentence summary of this thread.
Include: the topic, conclusion, and any decisions made.
If decisions were made, list them separately.

## Output (JSON only)
{
  "summary": "thread summary...",
  "new_decisions": ["decision1"]
}`;

  const user = `## Thread Messages\n${messagesBlock}`;

  return { system, user };
}
