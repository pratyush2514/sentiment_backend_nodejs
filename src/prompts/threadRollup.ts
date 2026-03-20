import {
  THREAD_EMOTIONAL_TEMPERATURES,
  THREAD_OPERATIONAL_RISKS,
  THREAD_STATES,
  THREAD_SURFACE_PRIORITIES,
  renderQuotedEnumList,
} from "../contracts/threadRollup.js";
import { buildUserMapFromMessages, resolveMentionsInText } from "./channelRollup.js";

export interface ThreadRollupContext {
  channelSummary: string;
  messages: Array<{ displayName: string | null; userId: string; text: string; ts: string }>;
}

export function buildThreadRollupPrompt(context: ThreadRollupContext): {
  system: string;
  user: string;
} {
  const userMap = buildUserMapFromMessages(context.messages);

  const messagesBlock = context.messages
    .map((m) => {
      const parsed = Number.parseFloat(m.ts);
      const time = Number.isFinite(parsed)
        ? new Date(parsed * 1000).toISOString().slice(11, 16)
        : m.ts;
      return `[${time}] [${m.displayName ?? m.userId}] ${resolveMentionsInText(m.text, userMap)}`;
    })
    .join("\n");

  const system = `You are summarizing a Slack thread so a manager can decide whether to step in.

## Channel Context
${context.channelSummary || "No channel summary is available yet."}

## Task
Write a concise 2-4 sentence summary of this thread focused on what a manager needs to act on.
Include:
- the core issue or question being discussed,
- the current state: resolved, in-progress, stalled, or escalating,
- any concrete decisions, owners, or follow-up actions with deadlines if mentioned.
Use single quotes around key phrases that deserve attention (e.g., the issue was described as 'blocking the release').
Do not mention that context was missing or that this is a rollup.

Also list any questions in the thread that have not received a visible answer. If all questions are answered, return an empty array.

You must also identify the operational state of the thread and the specific messages that changed the state of the conversation.
Treat low-signal acknowledgments and routine confirmations as context, not crucial moments.
       Messages like 'thanks', 'ok', 'haan', or 'that's the problem I am getting' are not crucial unless they materially change the thread state.
Only give "surface_priority" of "medium" or "high" when a manager would genuinely care right now:
- blocker, escalation, repeated confusion, ownership gap, missed commitment, external dependency, deadline risk, or unresolved tension.
- "resolved" threads with no open questions and no remaining operational risk should usually be "none".
- a message that merely opens a topic is not manager-worthy by itself unless it clearly introduces a blocker, escalation, or urgent decision.
- if your reason would sound generic, such as "introduced the issue that drives the thread", that moment should be recorded with "surfacePriority": "none" or omitted.

Use these thread states exactly:
${renderQuotedEnumList(THREAD_STATES)}

Use these emotional temperature labels exactly:
${renderQuotedEnumList(THREAD_EMOTIONAL_TEMPERATURES)}

Use these operational risk labels exactly:
${renderQuotedEnumList(THREAD_OPERATIONAL_RISKS)}

Use these surface priority labels exactly:
${renderQuotedEnumList(THREAD_SURFACE_PRIORITIES)}

For "operational_risk", use "none" when there is no material operational risk remaining.
For each item in "crucial_moments", "surfacePriority" must use the same labels as "surface_priority", including "none" when the moment is worth recording but not worth surfacing.

## Output (JSON only)
{
  "summary": "thread summary...",
  "new_decisions": ["decision1"],
  "open_questions": ["question that has no visible answer"],
  "primary_issue": "short plain-language description",
  "thread_state": "investigating",
  "emotional_temperature": "watch",
  "operational_risk": "medium",
  "surface_priority": "medium",
  "crucial_moments": [
    {
      "messageTs": "1234567890.123456",
      "kind": "blocked",
      "reason": "This message made it clear the team cannot continue until the external dependency is fixed.",
      "surfacePriority": "medium"
    }
  ]
}`;

  const user = `## Thread Messages\n${messagesBlock}`;

  return { system, user };
}
