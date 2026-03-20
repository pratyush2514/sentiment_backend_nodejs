import { config } from "../config.js";

type WindowRuleLike = {
  analysis_window_days?: number | null;
  analysisWindowDays?: number | null;
};

export const MIN_ANALYSIS_WINDOW_DAYS = 1;
export const MAX_ANALYSIS_WINDOW_DAYS = 30;

export function clampAnalysisWindowDays(days?: number | null): number {
  const configuredDefault =
    typeof config.SUMMARY_WINDOW_DAYS === "number" &&
      Number.isFinite(config.SUMMARY_WINDOW_DAYS)
      ? config.SUMMARY_WINDOW_DAYS
      : 7;
  const fallback = Math.max(
    MIN_ANALYSIS_WINDOW_DAYS,
    Math.min(MAX_ANALYSIS_WINDOW_DAYS, Math.round(configuredDefault)),
  );

  if (typeof days !== "number" || !Number.isFinite(days)) {
    return fallback;
  }

  return Math.max(
    MIN_ANALYSIS_WINDOW_DAYS,
    Math.min(MAX_ANALYSIS_WINDOW_DAYS, Math.round(days)),
  );
}

export function resolveAnalysisWindowDays(rule?: WindowRuleLike | null): number {
  return clampAnalysisWindowDays(
    rule?.analysis_window_days ?? rule?.analysisWindowDays ?? null,
  );
}

export function getAnalysisWindowStartTs(
  windowDays: number,
  nowMs: number = Date.now(),
): string {
  const safeWindowDays = clampAnalysisWindowDays(windowDays);
  return String((nowMs - safeWindowDays * 86_400_000) / 1000);
}

export function isTsWithinAnalysisWindow(
  ts: string,
  windowDays: number,
  nowMs: number = Date.now(),
): boolean {
  const parsedTs = Number.parseFloat(ts);
  if (!Number.isFinite(parsedTs)) {
    return false;
  }

  return parsedTs >= Number.parseFloat(getAnalysisWindowStartTs(windowDays, nowMs));
}
