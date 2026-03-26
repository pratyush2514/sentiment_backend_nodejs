import { z } from "zod/v4";

export const THREAD_STATES = [
  "monitoring",
  "investigating",
  "blocked",
  "waiting_external",
  "resolved",
  "escalated",
] as const;

export const THREAD_EMOTIONAL_TEMPERATURES = [
  "calm",
  "watch",
  "tense",
  "escalated",
] as const;

export const THREAD_SURFACE_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
] as const;

export const THREAD_OPERATIONAL_RISKS = [
  "none",
  "low",
  "medium",
  "high",
] as const;

export type ThreadState = typeof THREAD_STATES[number];
export type EmotionalTemperature = typeof THREAD_EMOTIONAL_TEMPERATURES[number];
export type ThreadSurfacePriority = typeof THREAD_SURFACE_PRIORITIES[number];
export type ThreadOperationalRisk = typeof THREAD_OPERATIONAL_RISKS[number];

// Map common invalid LLM outputs to valid thread states
const THREAD_STATE_COERCION: Record<string, typeof THREAD_STATES[number]> = {
  on_hold: "waiting_external",
  pending: "monitoring",
  in_progress: "investigating",
  active: "investigating",
  stalled: "blocked",
  stuck: "blocked",
  done: "resolved",
  completed: "resolved",
  closed: "resolved",
  urgent: "escalated",
  critical: "escalated",
  open: "monitoring",
  new: "monitoring",
  triaging: "investigating",
  awaiting: "waiting_external",
  waiting: "waiting_external",
  paused: "waiting_external",
};

export const ThreadStateSchema = z
  .unknown()
  .transform((val) => {
    if (typeof val !== "string") return "monitoring" as typeof THREAD_STATES[number];
    const lower = val.toLowerCase().trim();
    // If it's already valid, return as-is
    if (THREAD_STATES.includes(lower as typeof THREAD_STATES[number])) {
      return lower as typeof THREAD_STATES[number];
    }
    // Try coercion map
    if (lower in THREAD_STATE_COERCION) {
      return THREAD_STATE_COERCION[lower];
    }
    // Default fallback
    return "monitoring" as typeof THREAD_STATES[number];
  })
  .pipe(z.enum(THREAD_STATES));

// Coerce emotional temperature: accept unknown values and default to "calm"
const EMOTIONAL_TEMP_COERCION: Record<string, typeof THREAD_EMOTIONAL_TEMPERATURES[number]> = {
  warm: "watch",
  heated: "tense",
  hot: "escalated",
  cool: "calm",
  neutral: "calm",
  concerned: "watch",
  frustrated: "tense",
  angry: "escalated",
};

export const ThreadEmotionalTemperatureSchema = z
  .unknown()
  .transform((val) => {
    if (typeof val !== "string") return "calm" as typeof THREAD_EMOTIONAL_TEMPERATURES[number];
    const lower = val.toLowerCase().trim();
    if (THREAD_EMOTIONAL_TEMPERATURES.includes(lower as typeof THREAD_EMOTIONAL_TEMPERATURES[number])) {
      return lower as typeof THREAD_EMOTIONAL_TEMPERATURES[number];
    }
    if (lower in EMOTIONAL_TEMP_COERCION) {
      return EMOTIONAL_TEMP_COERCION[lower];
    }
    return "calm" as typeof THREAD_EMOTIONAL_TEMPERATURES[number];
  })
  .pipe(z.enum(THREAD_EMOTIONAL_TEMPERATURES));

export const ThreadSurfacePrioritySchema = z
  .unknown()
  .transform((val) => {
    if (typeof val !== "string") return val;
    const lower = val.toLowerCase().trim();
    if (THREAD_SURFACE_PRIORITIES.includes(lower as typeof THREAD_SURFACE_PRIORITIES[number])) {
      return lower as typeof THREAD_SURFACE_PRIORITIES[number];
    }
    return val;
  })
  .pipe(z.enum(THREAD_SURFACE_PRIORITIES));

export const ThreadOperationalRiskSchema = z
  .unknown()
  .transform((val) => {
    if (typeof val !== "string") return val;
    const lower = val.toLowerCase().trim();
    if (THREAD_OPERATIONAL_RISKS.includes(lower as typeof THREAD_OPERATIONAL_RISKS[number])) {
      return lower as typeof THREAD_OPERATIONAL_RISKS[number];
    }
    return val;
  })
  .pipe(z.enum(THREAD_OPERATIONAL_RISKS));

export function renderQuotedEnumList(values: readonly string[]): string {
  return values.map((value) => `- "${value}"`).join("\n");
}
