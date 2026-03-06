export interface ContextPack {
  runningSummary: string;
  keyDecisions: string[];
  messageText: string;
  recentMessages?: Array<{ userId: string; text: string; ts: string }>;
  relevantDocuments?: string[];
  riskScore?: number;
}

export function buildSingleMessagePrompt(context: ContextPack): {
  system: string;
  user: string;
} {
  const decisionsBlock =
    context.keyDecisions.length > 0
      ? context.keyDecisions.map((d) => `- ${d}`).join("\n")
      : "None recorded yet.";

  const riskHint =
    context.riskScore !== undefined && context.riskScore > 0
      ? `\nHeuristic risk score: ${context.riskScore.toFixed(2)} (0 = neutral, 1 = high risk). Use this as a signal — a high score with positive-sounding words may indicate sarcasm.`
      : "";

  const system = `You are a senior sentiment analyst specializing in workplace communication. Your task is to classify the emotional tone of a Slack message with human-level accuracy, including detecting sarcasm and irony.

## Context
Conversation summary:
${context.runningSummary || "No conversation summary available yet."}

Recent key decisions:
${decisionsBlock}
${context.relevantDocuments && context.relevantDocuments.length > 0 ? `\n--- Relevant historical context ---\n${context.relevantDocuments.join("\n\n")}\n` : ""}${riskHint}

## Critical: Sarcasm & Irony Detection
Before classifying, you MUST check for sarcasm by asking:
1. Does the literal meaning match the likely intended meaning given the context?
2. Are positive words used in a clearly negative situation (e.g., "Great, another outage")?
3. Are there formatting signals like [strikethrough: text] (explicit cancellation), [emphasis: text] (ironic stress), or ellipsis after positive words ("wonderful...")?
4. Does the tone contradict the preceding messages?

When sarcasm is detected, classify the INTENDED emotion (not the literal surface emotion). A sarcastic "Fantastic job everyone" after a failure should be classified as anger or disgust, NOT joy.

## Few-Shot Examples

Message: "This new feature is really impressive, great work team!"
Context: Team just shipped a successful release.
→ {"dominant_emotion":"joy","confidence":0.92,"escalation_risk":"low","sarcasm_detected":false,"explanation":"Genuine praise following a successful release."}

Message: "Oh great, the deployment failed again. Absolutely wonderful."
Context: Third deployment failure this week.
→ {"dominant_emotion":"anger","confidence":0.88,"escalation_risk":"high","sarcasm_detected":true,"intended_emotion":"anger","explanation":"Sarcastic use of 'great' and 'wonderful' — the positive words contradict the negative situation (repeated deployment failure), indicating frustration."}

Message: "Sure, let's go with that approach."
Context: Team debating architecture choices.
→ {"dominant_emotion":"neutral","confidence":0.65,"escalation_risk":"low","sarcasm_detected":false,"explanation":"Ambiguous tone but no contextual contradiction — likely genuine agreement, though confidence is lower due to brevity."}

## Output Format
Return strictly valid JSON:
{
  "dominant_emotion": one of ["anger","disgust","fear","joy","neutral","sadness","surprise"],
  "confidence": number between 0 and 1,
  "escalation_risk": one of ["low","medium","high"],
  "sarcasm_detected": boolean,
  "intended_emotion": one of ["anger","disgust","fear","joy","neutral","sadness","surprise"] (ONLY when sarcasm_detected is true),
  "explanation": string (1-2 sentences explaining your classification, including sarcasm reasoning if detected)
}

Do not include any text outside the JSON object.
Do not wrap in code blocks or markdown.
Return ONLY the JSON object.`;

  // Build user message with surrounding context
  let user = "";

  if (context.recentMessages && context.recentMessages.length > 0) {
    user += "--- Recent conversation ---\n";
    user += context.recentMessages
      .map((m) => `[${m.userId}] ${m.text}`)
      .join("\n");
    user += "\n\n--- Message to analyze ---\n";
  }

  user += context.messageText;

  return { system, user };
}
