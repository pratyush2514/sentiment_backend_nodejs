const HIGH_RISK_WORDS: readonly string[] = [
  "angry",
  "furious",
  "frustrated",
  "unacceptable",
  "terrible",
  "horrible",
  "ridiculous",
  "escalate",
  "cancel",
  "lawsuit",
  "disappointed",
  "outraged",
  "incompetent",
  "waste of time",
  "fed up",
];

// Positive words that become sarcasm signals when combined with negative context
const SARCASM_POSITIVE_WORDS = [
  "great", "fantastic", "wonderful", "brilliant", "amazing",
  "perfect", "excellent", "awesome", "nice", "lovely",
];

const SARCASM_NEGATIVE_CONTEXT = [
  "again", "another", "broke", "broken", "failed", "failure",
  "crashed", "down", "outage", "bug", "issue", "problem",
  "as usual", "of course", "obviously", "clearly",
];

/**
 * Computes a risk score (0-1) for a normalized message.
 *
 * Scoring:
 * - +0.3 per unique high-risk keyword (max 3 = 0.9)
 * - +0.2 for ALL CAPS sentences (>5 chars)
 * - +0.15 for excessive exclamation marks (3+)
 * - +0.15 for excessive question marks (3+)
 * - +0.25 for sarcasm-suspect patterns (positive word + negative context)
 * - +0.15 for ellipsis after positive words (e.g., "great...")
 * - +0.15 for quoted praise (e.g., "great" job)
 * - +0.1 for [strikethrough: ...] markers (explicit sarcasm signal)
 * - Capped at 1.0
 */
export function computeRiskScore(normalizedText: string): number {
  if (!normalizedText.trim()) return 0;

  let score = 0;
  const lowerText = normalizedText.toLowerCase();

  // Count unique high-risk keyword matches
  let matchCount = 0;
  for (const word of HIGH_RISK_WORDS) {
    if (lowerText.includes(word)) {
      matchCount++;
    }
  }
  score += Math.min(matchCount, 3) * 0.3;

  // ALL CAPS sentences (segments > 5 chars that are entirely uppercase)
  const sentences = normalizedText.split(/[.!?]+/);
  const capsCount = sentences.filter(
    (s) => s.trim().length > 5 && s.trim() === s.trim().toUpperCase(),
  ).length;
  if (capsCount > 0) {
    score += 0.2;
  }

  // Excessive exclamation marks
  if (/!{3,}/.test(normalizedText)) {
    score += 0.15;
  }

  // Excessive question marks
  if (/\?{3,}/.test(normalizedText)) {
    score += 0.15;
  }

  // ─── Sarcasm-suspect patterns ───────────────────────────────────────────────

  // Positive word + negative context in the same message
  const hasPositive = SARCASM_POSITIVE_WORDS.some((w) => lowerText.includes(w));
  const hasNegativeContext = SARCASM_NEGATIVE_CONTEXT.some((w) => lowerText.includes(w));
  if (hasPositive && hasNegativeContext) {
    score += 0.25;
  }

  // Ellipsis after positive words (e.g., "great...", "wonderful...")
  const ellipsisPattern = new RegExp(
    `\\b(${SARCASM_POSITIVE_WORDS.join("|")})\\.{2,}`,
    "i",
  );
  if (ellipsisPattern.test(normalizedText)) {
    score += 0.15;
  }

  // Quoted praise — "great" job, "nice" work
  const quotedPattern = new RegExp(
    `["'](${SARCASM_POSITIVE_WORDS.join("|")})["']`,
    "i",
  );
  if (quotedPattern.test(normalizedText)) {
    score += 0.15;
  }

  // Strikethrough markers — explicit sarcasm signal from Slack formatting
  if (lowerText.includes("[strikethrough:")) {
    score += 0.1;
  }

  return Math.min(score, 1.0);
}
