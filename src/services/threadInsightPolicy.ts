import type {
  CrucialMoment,
  EmotionalTemperature,
  OperationalRisk,
  SurfacePriority,
  ThreadState,
} from "../types/database.js";

export interface ThreadInsightPolicyInput {
  threadState?: ThreadState | null;
  operationalRisk?: OperationalRisk | null;
  emotionalTemperature?: EmotionalTemperature | null;
  surfacePriority?: SurfacePriority | null;
  openQuestions?: string[] | null;
  crucialMoments?: CrucialMoment[] | null;
}

const GENERIC_STRUCTURAL_REASON_PATTERNS = [
  /introduced the issue that drives the thread/i,
  /introduced the issue/i,
  /drives the thread/i,
  /changed the state of the conversation/i,
  /opened the thread/i,
  /started the discussion/i,
];

function hasOpenQuestions(openQuestions?: string[] | null): boolean {
  return (openQuestions ?? []).some((question) => question.trim().length > 0);
}

export function isSurfacedPriority(
  value?: SurfacePriority | null,
): value is "medium" | "high" {
  return value === "medium" || value === "high";
}

export function isSurfaceableCrucialMoment(moment: CrucialMoment): boolean {
  return isSurfacedPriority(moment.surfacePriority);
}

export function isGenericStructuralCrucialMoment(moment: CrucialMoment): boolean {
  if (moment.kind !== "issue_opened" && moment.kind !== "turning_point") {
    return false;
  }

  return GENERIC_STRUCTURAL_REASON_PATTERNS.some((pattern) => pattern.test(moment.reason));
}

export function normalizeCrucialMoments(
  moments?: CrucialMoment[] | null,
): CrucialMoment[] {
  const deduped = new Map<string, CrucialMoment>();

  for (const moment of moments ?? []) {
    if (!moment.messageTs) {
      continue;
    }

    const normalizedMoment: CrucialMoment = isGenericStructuralCrucialMoment(moment)
      ? { ...moment, surfacePriority: "none" }
      : moment;

    const key = `${normalizedMoment.messageTs}:${normalizedMoment.kind}:${normalizedMoment.reason}`;
    if (!deduped.has(key)) {
      deduped.set(key, normalizedMoment);
    }
  }

  return Array.from(deduped.values());
}

export function hasIntrinsicManagerPressure(
  input: Omit<ThreadInsightPolicyInput, "surfacePriority">,
): boolean {
  if (input.threadState === "blocked" || input.threadState === "escalated") {
    return true;
  }

  if (input.operationalRisk === "medium" || input.operationalRisk === "high") {
    return true;
  }

  if (input.emotionalTemperature === "escalated") {
    return true;
  }

  if (input.threadState === "waiting_external" && hasOpenQuestions(input.openQuestions)) {
    return true;
  }

  return normalizeCrucialMoments(input.crucialMoments).some(isSurfaceableCrucialMoment);
}

export function deriveThreadSurfacePriority(
  input: ThreadInsightPolicyInput,
): SurfacePriority {
  const normalizedPriority = input.surfacePriority ?? "none";
  const normalizedMoments = normalizeCrucialMoments(input.crucialMoments);
  const managerPressure = hasIntrinsicManagerPressure({
    threadState: input.threadState,
    operationalRisk: input.operationalRisk,
    emotionalTemperature: input.emotionalTemperature,
    openQuestions: input.openQuestions,
    crucialMoments: normalizedMoments,
  });

  if (
    (input.threadState === "resolved" || input.threadState === "monitoring") &&
    input.operationalRisk === "none" &&
    input.emotionalTemperature === "calm" &&
    !hasOpenQuestions(input.openQuestions) &&
    !normalizedMoments.some(isSurfaceableCrucialMoment)
  ) {
    return "none";
  }

  if (!managerPressure && isSurfacedPriority(normalizedPriority)) {
    return "none";
  }

  return normalizedPriority;
}

export function isManagerRelevantThreadInsight(
  input: ThreadInsightPolicyInput,
): boolean {
  const effectiveSurfacePriority = deriveThreadSurfacePriority(input);
  if (isSurfacedPriority(effectiveSurfacePriority)) {
    return true;
  }

  if (input.threadState === "blocked" || input.threadState === "escalated") {
    return true;
  }

  if (input.operationalRisk === "medium" || input.operationalRisk === "high") {
    return true;
  }

  return (
    input.threadState === "waiting_external" &&
    hasOpenQuestions(input.openQuestions) &&
    effectiveSurfacePriority !== "none"
  );
}
