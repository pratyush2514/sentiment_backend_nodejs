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

export const ThreadStateSchema = z.enum(THREAD_STATES);
export const ThreadEmotionalTemperatureSchema = z.enum(THREAD_EMOTIONAL_TEMPERATURES);
export const ThreadSurfacePrioritySchema = z.enum(THREAD_SURFACE_PRIORITIES);
export const ThreadOperationalRiskSchema = z.enum(THREAD_OPERATIONAL_RISKS);

export function renderQuotedEnumList(values: readonly string[]): string {
  return values.map((value) => `- "${value}"`).join("\n");
}
