import { config } from "../config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SensitiveCategory =
  | "api_key"
  | "jwt"
  | "email"
  | "phone"
  | "credit_card"
  | "ip_address"
  | "base64_blob"
  | "hex_blob"
  | "password"
  | "private_url";

export interface SensitiveMatch {
  category: SensitiveCategory;
  index: number;
  length: number;
}

export interface PrivacyDetectionResult {
  hasSensitiveContent: boolean;
  matches: SensitiveMatch[];
  score: number;
}

export interface SanitizeTelemetry {
  categories: SensitiveCategory[];
  matchCount: number;
  score: number;
}

export type PrivacyMode = "off" | "redact" | "skip";

export type SanitizeResult =
  | { action: "passthrough"; text: string; telemetry: null }
  | { action: "redacted"; text: string; redactedCount: number; telemetry: SanitizeTelemetry }
  | { action: "skipped"; telemetry: SanitizeTelemetry };

export interface SanitizeSummary {
  sensitiveMessageCount: number;
  redactedMessageCount: number;
  skippedMessageCount: number;
  categories: SensitiveCategory[];
  highestScore: number;
}

// ─── Detection Patterns ─────────────────────────────────────────────────────
// Compiled once at module load for performance.

interface PatternDef {
  category: SensitiveCategory;
  pattern: RegExp;
  score: number;
}

const REDACTED_PLACEHOLDER = " "; // Neutral placeholder to avoid polluting LLM context

const PATTERNS: PatternDef[] = [
  // API keys: OpenAI sk-, Slack xox[bpras]-, GitHub ghp_/glpat-, AWS AKIA
  {
    category: "api_key",
    pattern: /(?:sk-[a-zA-Z0-9]{20,}|xox[bpras]-[a-zA-Z0-9-]{10,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16})/g,
    score: 0.5,
  },
  // JWT tokens: three base64url segments separated by dots
  {
    category: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,}/g,
    score: 0.5,
  },
  // Email addresses
  {
    category: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    score: 0.2,
  },
  // Phone numbers (US/intl with optional country code)
  {
    category: "phone",
    pattern: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    score: 0.2,
  },
  // Credit card numbers (Visa, MC, Amex, Discover)
  {
    category: "credit_card",
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    score: 0.5,
  },
  // IPv4 addresses (excluding private/loopback ranges)
  {
    category: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    score: 0.15,
  },
  // Long base64 strings (40+ chars, likely encoded secrets)
  {
    category: "base64_blob",
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
    score: 0.3,
  },
  // Long hex strings (32+ chars, likely SHA hashes or hex-encoded secrets)
  {
    category: "hex_blob",
    pattern: /\b[0-9a-fA-F]{32,}\b/g,
    score: 0.3,
  },
  // Password/secret assignments: password=xxx, secret: xxx, api_key=xxx
  {
    category: "password",
    pattern: /(?:password|passwd|pwd|secret|token|api_key|apikey|auth_token|access_token|private_key)\s*[:=]\s*\S+/gi,
    score: 0.5,
  },
  // Private/internal URLs
  {
    category: "private_url",
    pattern: /https?:\/\/(?:[a-z0-9-]+\.)*(?:internal|local|corp|private|staging|dev|localhost)(?:\.[a-z]+)?(?::[0-9]+)?[/\S]*/gi,
    score: 0.2,
  },
];

// Private IP ranges to exclude from ip_address matches
const PRIVATE_IP_RE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0)/;

// ─── Detection ──────────────────────────────────────────────────────────────

export function detectSensitiveContent(text: string): PrivacyDetectionResult {
  if (!text || text.trim().length === 0) {
    return { hasSensitiveContent: false, matches: [], score: 0 };
  }

  const matches: SensitiveMatch[] = [];
  const seenCategories = new Set<SensitiveCategory>();

  for (const def of PATTERNS) {
    // Reset regex lastIndex for each scan
    def.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = def.pattern.exec(text)) !== null) {
      // Filter out private/loopback IPs
      if (def.category === "ip_address" && PRIVATE_IP_RE.test(match[0])) {
        continue;
      }

      matches.push({
        category: def.category,
        index: match.index,
        length: match[0].length,
      });
      seenCategories.add(def.category);
    }
  }

  // Score: additive per unique category, capped at 1.0
  let score = 0;
  for (const cat of seenCategories) {
    const def = PATTERNS.find((p) => p.category === cat);
    if (def) score += def.score;
  }
  score = Math.min(score, 1.0);

  return {
    hasSensitiveContent: matches.length > 0,
    matches,
    score,
  };
}

// ─── Redaction ──────────────────────────────────────────────────────────────

export function redactSensitiveContent(
  text: string,
  matches: SensitiveMatch[],
): string {
  if (matches.length === 0) return text;

  // Merge overlapping intervals then replace from end to start
  const sorted = [...matches].sort((a, b) => a.index - b.index);
  const merged: Array<{ start: number; end: number }> = [];

  for (const m of sorted) {
    const end = m.index + m.length;
    const last = merged[merged.length - 1];
    if (last && m.index <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      merged.push({ start: m.index, end });
    }
  }

  // Replace from end to preserve indices
  let result = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end } = merged[i];
    result = result.slice(0, start) + REDACTED_PLACEHOLDER + result.slice(end);
  }

  return result;
}

// ─── Gateway ────────────────────────────────────────────────────────────────

export function sanitizeForExternalUse(
  text: string,
  mode?: PrivacyMode,
): SanitizeResult {
  const effectiveMode = mode ?? (config.PRIVACY_MODE as PrivacyMode);

  if (effectiveMode === "off") {
    return { action: "passthrough", text, telemetry: null };
  }

  const detection = detectSensitiveContent(text);

  if (!detection.hasSensitiveContent) {
    return { action: "passthrough", text, telemetry: null };
  }
  const telemetry: SanitizeTelemetry = {
    categories: [...new Set(detection.matches.map((m) => m.category))],
    matchCount: detection.matches.length,
    score: detection.score,
  };

  if (effectiveMode === "skip") {
    return { action: "skipped", telemetry };
  }

  // effectiveMode === "redact"
  const redacted = redactSensitiveContent(text, detection.matches);
  return {
    action: "redacted",
    text: redacted,
    redactedCount: detection.matches.length,
    telemetry,
  };
}

export function summarizeSanitizeResults(
  results: readonly SanitizeResult[],
): SanitizeSummary {
  const categories = new Set<SensitiveCategory>();
  let sensitiveMessageCount = 0;
  let redactedMessageCount = 0;
  let skippedMessageCount = 0;
  let highestScore = 0;

  for (const result of results) {
    if (!result.telemetry) {
      continue;
    }

    sensitiveMessageCount += 1;
    highestScore = Math.max(highestScore, result.telemetry.score);

    for (const category of result.telemetry.categories) {
      categories.add(category);
    }

    if (result.action === "redacted") {
      redactedMessageCount += 1;
    } else if (result.action === "skipped") {
      skippedMessageCount += 1;
    }
  }

  return {
    sensitiveMessageCount,
    redactedMessageCount,
    skippedMessageCount,
    categories: [...categories],
    highestScore,
  };
}
