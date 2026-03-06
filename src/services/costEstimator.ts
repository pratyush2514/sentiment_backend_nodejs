import { logger } from "../utils/logger.js";

const log = logger.child({ module: "costEstimator" });

// ─── Cost rates per 1M tokens ──────────────────────────────────────────────

const COST_RATES: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.30 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

// Conservative fallback: use highest known rate
const FALLBACK_RATE = { input: 3.00, output: 15.00 };

export function findRate(model: string): { input: number; output: number } {
  // Exact match first
  if (COST_RATES[model]) return COST_RATES[model];
  // OpenAI returns versioned names like "gpt-4o-mini-2024-07-18" — match base model
  const base = Object.keys(COST_RATES).find((k) => model.startsWith(k));
  if (base) return COST_RATES[base];
  log.warn({ model }, "Unknown model for cost estimation, using fallback rate");
  return FALLBACK_RATE;
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = findRate(model);
  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;
}
