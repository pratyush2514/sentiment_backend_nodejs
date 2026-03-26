import type { FathomActionItem } from "../types/database.js";

export interface MeetingExtractionContext {
  title: string;
  durationMinutes: number | null;
  participantNames: string[];
  fathomSummary: string | null;
  fathomActionItems: FathomActionItem[];
  transcript: string | null;
  maxTranscriptTokens: number;
  currentDate?: string; // ISO date string e.g. "2026-03-24"
}

export function buildMeetingExtractionPrompt(context: MeetingExtractionContext): {
  system: string;
  user: string;
} {
  const system = `You are an expert at analyzing meeting transcripts and extracting actionable intelligence.

## Task
Given a meeting summary, action items, and transcript, extract ALL obligations, decisions, risks, and commitments.

For each obligation, determine:
- **type**: action_item, decision, commitment, question, risk, or next_step
- **title**: concise description (max 200 chars)
- **description**: additional context if needed (max 500 chars)
- **ownerName**: who is responsible (use the person's name as it appears in the transcript)
- **dueDate**: ISO date string if explicitly or implicitly mentioned. Use the current date provided in the meeting context to resolve relative dates (e.g., "by Friday" → nearest future Friday, "end of week" → Friday of this week, "next week" → following Monday, "tomorrow" → next day). Use null if no timeline mentioned.
- **priority**: low, medium, high, or critical based on urgency language and context
- **confidence**: 0-1 how confident you are this is a real obligation
- **sourceContext**: brief excerpt from transcript that supports this (max 300 chars)

Also assess:
- **meetingSentiment**: positive, neutral, concerned, or tense
- **riskSignals**: up to 5 short risk indicators found in the meeting

## Important Rules
- Include Fathom's pre-extracted action items as action_item obligations (validate and enrich them)
- Look for IMPLICIT commitments: "Yeah I'll take care of that", "We can do that", "Let me check"
- Look for DECISIONS that aren't action items: "We decided to go with vendor B", "Let's push the deadline"
- Look for RISKS mentioned in passing: "If we miss this...", "The client seemed frustrated"
- Do NOT invent obligations not supported by the text
- Return valid JSON only, no markdown or commentary

## Output Format
{
  "obligations": [
    {
      "type": "action_item" | "decision" | "commitment" | "question" | "risk" | "next_step",
      "title": "string",
      "description": "string or null",
      "ownerName": "string or null",
      "dueDate": "YYYY-MM-DD or null",
      "priority": "low" | "medium" | "high" | "critical",
      "confidence": 0.0-1.0,
      "sourceContext": "string or null"
    }
  ],
  "meetingSentiment": "positive" | "neutral" | "concerned" | "tense",
  "riskSignals": ["string"]
}`;

  // Build user prompt with meeting data
  const parts: string[] = [];

  parts.push(`## Meeting: ${context.title}`);
  parts.push(`Current date: ${context.currentDate ?? new Date().toISOString().split("T")[0]}`);
  if (context.durationMinutes) {
    parts.push(`Duration: ${context.durationMinutes} minutes`);
  }
  if (context.participantNames.length > 0) {
    parts.push(`Participants: ${context.participantNames.join(", ")}`);
  }

  if (context.fathomSummary) {
    parts.push(`\n## Meeting Summary (from Fathom)\n${context.fathomSummary}`);
  }

  if (context.fathomActionItems.length > 0) {
    parts.push(`\n## Pre-extracted Action Items (from Fathom)`);
    for (const item of context.fathomActionItems) {
      const assignee = item.assignee ? ` (assigned to: ${item.assignee})` : "";
      parts.push(`- ${item.text}${assignee}`);
    }
  }

  if (context.transcript) {
    // Truncate transcript to fit token budget
    const truncated = truncateToTokenBudget(context.transcript, context.maxTranscriptTokens);
    parts.push(`\n## Transcript\n${truncated}`);
  }

  const user = parts.join("\n");

  return { system, user };
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  // Rough approximation: 1 token ≈ 4 characters
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[... transcript truncated ...]";
}
