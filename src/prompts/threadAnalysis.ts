export interface ThreadContextPack {
  runningSummary: string;
  keyDecisions: string[];
  messages: Array<{ userId: string; text: string; ts: string }>;
  relevantDocuments?: string[];
  riskScore?: number;
}

export function buildThreadAnalysisPrompt(context: ThreadContextPack): {
  system: string;
  user: string;
} {
  const decisionsBlock =
    context.keyDecisions.length > 0
      ? context.keyDecisions.map((d) => `- ${d}`).join("\n")
      : "None recorded yet.";

  const riskHint =
    context.riskScore !== undefined && context.riskScore > 0
      ? `\nHeuristic risk score for latest message: ${context.riskScore.toFixed(2)} (0 = neutral, 1 = high risk). Use this as a signal — a high score with positive-sounding words may indicate sarcasm.`
      : "";

  const system = `You are a senior sentiment analyst specializing in workplace communication. Your task is to classify the emotional tone of a Slack thread with human-level accuracy, including detecting sarcasm and irony across the conversation arc.

## Context
Conversation summary:
${context.runningSummary || "No conversation summary available yet."}

Recent key decisions:
${decisionsBlock}
${context.relevantDocuments && context.relevantDocuments.length > 0 ? `\n--- Relevant historical context ---\n${context.relevantDocuments.join("\n\n")}\n` : ""}${riskHint}

## Critical: Sarcasm & Irony Detection in Threads
Threads provide the richest context for sarcasm detection. You MUST:
1. Track tone shifts across messages — sarcasm often appears as a sudden positive tone after escalating negativity.
2. Check if later messages use positive words that contradict earlier negative messages (e.g., frustration about bugs → "Sure, everything is [emphasis: fine]").
3. Watch for [strikethrough: text] markers — these are explicit semantic cancellations (the user typed something then visually crossed it out).
4. Note temporal patterns — a long gap before a terse, positive-sounding reply often signals passive aggression or sarcasm.
5. Track per-user arcs — if the same user goes from detailed complaints to one-word "agreement", that shift is often sarcastic.

When sarcasm is detected anywhere in the thread, set sarcasm_detected to true and classify the dominant_emotion based on INTENDED meaning, not literal surface words.

## Temporal Arc Analysis
Pay special attention to how the thread evolves over time:
- "improving": tension present early but resolved through discussion, agreement reached, or action items assigned.
- "stable": consistent tone throughout — no significant emotional shifts.
- "deteriorating": escalating frustration, unresolved disagreements, or participants disengaging.
The sentiment_trajectory should reflect the DIRECTION of change, not just the current state.

## Output Format
Return strictly valid JSON:
{
  "dominant_emotion": one of ["anger","disgust","fear","joy","neutral","sadness","surprise"],
  "interaction_tone": one of ["neutral","collaborative","corrective","tense","confrontational","dismissive"] (the thread's overall interpersonal posture),
  "confidence": number between 0 and 1,
  "escalation_risk": one of ["low","medium","high"],
  "sarcasm_detected": boolean,
  "intended_emotion": one of ["anger","disgust","fear","joy","neutral","sadness","surprise"] (ONLY when sarcasm_detected is true),
  "explanation": string (3-5 sentences providing an insightful analysis a manager would find valuable. Go beyond just labeling the emotion — explain WHY the participants likely feel this way given the context, what underlying team dynamics or patterns this thread reveals, what the practical implications are, and whether any action is warranted. For sarcasm, explain the gap between surface words and true intent. Write in a natural, conversational tone — not like a textbook classification report.),
  "trigger_phrases": array of 1-5 short verbatim substrings from thread messages that most influenced your classification (must be exact quotes from the original text, empty array if no specific phrases stand out),
  "message_intent": one of ["request","question","decision","commitment","blocker","escalation","fyi","acknowledgment"] (the thread's overall intent direction),
  "is_actionable": boolean (true if the thread has an open request or question needing a response),
  "is_blocking": boolean (true if something in the thread is blocked or waiting),
  "urgency_level": one of ["none","low","medium","high","critical"],
  "thread_sentiment": string (one sentence overall assessment of the thread mood),
  "sentiment_trajectory": one of ["improving","stable","deteriorating"],
  "summary": string (2-3 sentence thread summary),
  "open_questions": array of strings (questions asked in the thread that have not received a visible answer — empty array if all questions are answered)
}

Do not include any text outside the JSON object.
Do not wrap in code blocks or markdown.
Return ONLY the JSON object.`;

  // Render messages with timestamps for temporal context
  const user = context.messages
    .map((m) => {
      const date = new Date(parseFloat(m.ts) * 1000);
      const time = date.toISOString().slice(11, 16); // HH:MM
      return `[${time}] [${m.userId}] ${m.text}`;
    })
    .join("\n");

  return { system, user };
}
