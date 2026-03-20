import type {
  AttentionSummary,
  MessageDispositionCounts,
  RiskDriver,
} from "../types/database.js";

export interface ChannelRollupContext {
  existingSummary: string;
  existingDecisions: string[];
  messages: Array<{ displayName: string | null; userId: string; text: string; ts: string }>;
  canonicalState?: {
    effectiveChannelMode: "collaboration" | "automation" | "mixed";
    signal: "stable" | "elevated" | "escalating";
    health: "healthy" | "attention" | "at-risk";
    riskDrivers: RiskDriver[];
    attentionSummary: AttentionSummary;
    messageDispositionCounts: MessageDispositionCounts;
    relatedIncidents?: Array<{
      sourceChannelName: string;
      message: string;
      detectedAt: string | null;
      blocksLocalWork: boolean;
    }>;
  };
}

/**
 * Replace raw Slack `<@USERID>` mentions with display names so the LLM
 * (and any text derived from its output) uses human-readable names.
 */
export function resolveMentionsInText(
  text: string,
  userMap: Map<string, string>,
): string {
  return text.replace(/<@([A-Z0-9]+)>/gi, (_match, userId: string) => {
    const name = userMap.get(userId);
    return name ? `@${name}` : `@${userId}`;
  });
}

export function buildUserMapFromMessages(
  messages: Array<{ displayName: string | null; userId: string }>,
): Map<string, string> {
  const userMap = new Map<string, string>();
  for (const m of messages) {
    if (m.displayName && !userMap.has(m.userId)) {
      userMap.set(m.userId, m.displayName);
    }
  }
  return userMap;
}

export function buildChannelRollupPrompt(context: ChannelRollupContext): {
  system: string;
  user: string;
} {
  const userMap = buildUserMapFromMessages(context.messages);

  const decisionsBlock = context.existingDecisions.length > 0
    ? context.existingDecisions.map((d) => `- ${d}`).join("\n")
    : "None yet.";

  const messagesBlock = context.messages
    .map((m) => {
      const parsed = Number.parseFloat(m.ts);
      const time = Number.isFinite(parsed)
        ? new Date(parsed * 1000).toISOString().slice(11, 16)
        : m.ts;
      return `[${time}] [${m.displayName ?? m.userId}] ${resolveMentionsInText(m.text, userMap)}`;
    })
    .join("\n");

  const canonicalStateBlock = context.canonicalState
    ? [
        `Channel mode: ${context.canonicalState.effectiveChannelMode}`,
        `Signal: ${context.canonicalState.signal}`,
        `Health: ${context.canonicalState.health}`,
        `Attention summary: ${context.canonicalState.attentionSummary.title} — ${context.canonicalState.attentionSummary.message}`,
        `Coverage: deep_ai_analyzed=${context.canonicalState.messageDispositionCounts.deepAiAnalyzed}, heuristic_incidents=${context.canonicalState.messageDispositionCounts.heuristicIncidentSignals}, context_only=${context.canonicalState.messageDispositionCounts.contextOnly}, routine_acknowledgments=${context.canonicalState.messageDispositionCounts.routineAcknowledgments}, in_flight=${context.canonicalState.messageDispositionCounts.inFlight}`,
        `Related incidents: ${
          context.canonicalState.relatedIncidents &&
          context.canonicalState.relatedIncidents.length > 0
            ? context.canonicalState.relatedIncidents
                .map(
                  (incident) =>
                    `- [${incident.sourceChannelName}] ${incident.message}${
                      incident.blocksLocalWork ? " (mentioned as affecting local work)" : ""
                    }`,
                )
                .join("\n")
            : "None referenced."
        }`,
        `Risk drivers: ${
          context.canonicalState.riskDrivers.length > 0
            ? context.canonicalState.riskDrivers
                .map(
                  (driver) =>
                    `- [${driver.category}/${driver.severity}] ${driver.label}: ${driver.message}`,
                )
                .join("\n")
            : "None currently active."
        }`,
      ].join("\n")
    : "Unavailable.";

  const system = `You are an operations-focused analyst summarizing a Slack channel for a busy manager.

## Existing Summary
${context.existingSummary || "No prior AI summary is available yet."}

## Existing Key Decisions
${decisionsBlock}

## Canonical Channel State
${canonicalStateBlock}

## Task
1. Write an updated running summary that helps a manager understand the channel RIGHT NOW.
   - Treat the canonical channel state above as the source of truth for current status, risk, and attention.
   - Explain that state using the new messages; do not contradict it.
   - This summary should reflect the CURRENT state — what's happening this week.
   - Actively DROP topics from the existing summary that are no longer active, resolved, or stale.
   - Focus on current topics, blockers, risks, accountability, decisions, and next steps.
   - If the canonical state is stable/clear, do not invent blockers or escalation.
   - If the channel mode is automation or mixed, describe failures/incidents as operational issues rather than interpersonal sentiment.
   - Treat related incidents from other channels as context, not as local incidents, unless they are explicitly described as blocking work in this channel.
   - Mention names only when they clarify ownership or tension.
   - Keep it concrete and evidence-based; no generic filler.
   - Never mention that the prior summary was missing, this is a rollup, or that messages were backfilled.
   - Use single quotes around key phrases that deserve attention (e.g., the team described the outage as 'critical priority').
2. Extract only truly NEW key decisions, commitments, or action items.
   - Do not repeat existing decisions.
   - Remove decisions that appear resolved or superseded by new information.
   - If there are no new decisions, return an empty array.
   - Each decision should be a single, specific sentence with an owner if mentioned.
3. Keep the summary between 80-220 words. Shorter is better when the content is straightforward.

## Output (JSON only)
{
  "summary": "updated running summary...",
  "new_decisions": ["decision1", "decision2"]
}`;

  const user = `## New Messages\n${messagesBlock}`;

  return { system, user };
}
