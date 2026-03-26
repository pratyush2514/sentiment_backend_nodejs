import type {
  AnalysisStatus,
  BackfillRunPhase,
  BackfillRunStatus,
  IngestReadiness,
  IntelligenceReadiness,
  MessageIntelligenceEligibilityStatus,
  MessageIntelligenceExecutionStatus,
  MessageIntelligenceQualityStatus,
  MessageIntelligenceSuppressionReason,
  SummaryArtifactCompletenessStatus,
} from "../types/database.js";

export function deriveLegacyAnalysisStatus(input: {
  eligibilityStatus?: MessageIntelligenceEligibilityStatus | null;
  executionStatus?: MessageIntelligenceExecutionStatus | null;
  qualityStatus?: MessageIntelligenceQualityStatus | null;
  suppressionReason?: MessageIntelligenceSuppressionReason | null;
}): AnalysisStatus {
  if (
    input.eligibilityStatus === "not_candidate" ||
    input.eligibilityStatus === "policy_suppressed" ||
    input.eligibilityStatus === "privacy_suppressed" ||
    input.suppressionReason
  ) {
    return "skipped";
  }

  switch (input.executionStatus) {
    case "failed":
      return "failed";
    case "processing":
      return "processing";
    case "completed":
      return input.qualityStatus === "verified" ? "completed" : "processing";
    case "pending":
    case "not_run":
    default:
      return "pending";
  }
}

export function deriveIngestReadinessFromBackfillRun(input: {
  status?: BackfillRunStatus | null;
  currentPhase?: BackfillRunPhase | null;
  messagesImported?: number | null;
} | null | undefined): IngestReadiness {
  if (!input?.status) {
    return "not_started";
  }

  if (input.status === "running") {
    return "hydrating";
  }

  if (input.status === "completed" || input.status === "completed_with_degradations") {
    return "ready";
  }

  if ((input.messagesImported ?? 0) > 0 || input.currentPhase) {
    return "hydrating";
  }

  return "not_started";
}

export function deriveIntelligenceReadinessFromArtifact(input: {
  completenessStatus?: SummaryArtifactCompletenessStatus | null;
  activeDegradationCount?: number | null;
} | null | undefined): IntelligenceReadiness {
  if (!input?.completenessStatus) {
    return "missing";
  }

  switch (input.completenessStatus) {
    case "complete":
      return input.activeDegradationCount && input.activeDegradationCount > 0
        ? "partial"
        : "ready";
    case "partial":
      return "partial";
    case "stale":
      return "stale";
    case "no_recent_messages":
    default:
      return "missing";
  }
}

export function normalizeDegradedReasons(
  reasons: readonly string[] | null | undefined,
): string[] {
  if (!reasons || reasons.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      reasons
        .map((reason) => reason.trim())
        .filter((reason): reason is string => reason.length > 0),
    ),
  );
}
