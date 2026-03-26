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
      return `[${time}] [ts=${m.ts}] [${m.displayName ?? m.userId}] ${resolveMentionsInText(m.text, userMap)}`;
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
1. Extract only facts that are directly supported by the provided messages.
   - Every extracted item MUST include 1 to 3 exact \`evidence_ts\` values copied from the messages above.
   - Pick the most representative 1-3 timestamps. Do NOT include more than 3.
   - If you cannot support an item with an exact \`ts\`, omit it.
   - Do not invent blockers, resolutions, or decisions from the existing summary alone.
2. Focus on what matters to a manager RIGHT NOW:
   - active topics and what is actively being discussed
   - blockers, operational risks, and what is holding up work
   - recent resolutions, progress, or completed work
   - truly new decisions, commitments, or action items with their context
3. Treat the canonical channel state as contextual guidance, not as permission to invent unsupported claims.
4. Keep each extracted fact highly detailed. Write full, descriptive sentences that explain the context, who is involved, and what the specific details are. Do not use short fragments.
5. Do not output a narrative paragraph. The backend will generate the visible summary from your structured facts.

## Output (JSON only)
{
  "active_topics": [
    { "text": "Detailed, full sentence explaining the topic, who is involved, and specific details discussed.", "evidence_ts": ["1234567890.123456"] }
  ],
  "blockers": [
    { "text": "Detailed, full sentence explaining the specific blocker, risk, and its impact.", "evidence_ts": ["1234567890.123456"] }
  ],
  "resolutions": [
    { "text": "Detailed, full sentence explaining the specific progress, resolution, or completed work.", "evidence_ts": ["1234567890.123456"] }
  ],
  "new_decisions": [
    { "text": "Detailed, full sentence explaining the specific decision, next step, or commitment.", "evidence_ts": ["1234567890.123456"] }
  ]
}
IMPORTANT: Each evidence_ts array must have 1-3 items only. Never more than 3.`;

  const user = `## New Messages\n${messagesBlock}`;

  return { system, user };
}
