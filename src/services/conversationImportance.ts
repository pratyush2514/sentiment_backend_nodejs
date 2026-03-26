import { config } from "../config.js";
import type { ChannelClassificationType, ConversationType } from "../types/database.js";

export type ImportanceTierOverride =
  | "auto"
  | "high_value"
  | "standard"
  | "low_value";

export type ImportanceTier = Exclude<ImportanceTierOverride, "auto">;

export interface ConversationImportanceInput {
  channelName?: string | null;
  conversationType?: ConversationType | null;
  clientUserIds?: string[] | null;
  importanceTierOverride?: ImportanceTierOverride | null;
  /** AI-classified channel type (from channel_classifications table) */
  channelType?: ChannelClassificationType | null;
  /** Classification confidence (0-1). Only trust classification for high-stakes decisions when > 0.6 */
  classificationConfidence?: number | null;
  /** Classification source. Human overrides are always trusted. */
  classificationSource?: string | null;
}

/** Minimum confidence to use AI classification for importance tier decisions.
 * Below this, fall through to heuristics. Human overrides bypass this gate. */
const CLASSIFICATION_TRUST_THRESHOLD = 0.6;

export interface ConversationImportanceResolution {
  importanceTierOverride: ImportanceTierOverride;
  recommendedImportanceTier: ImportanceTier;
  effectiveImportanceTier: ImportanceTier;
}

function normalizeChannelName(name?: string | null): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_-]+/g, "");
}

export function normalizeImportanceTierOverride(
  value?: string | null,
): ImportanceTierOverride {
  switch (value) {
    case "high_value":
    case "standard":
    case "low_value":
    case "auto":
      return value;
    default:
      return "auto";
  }
}

export function normalizeImportanceTier(
  value?: string | null,
): ImportanceTier {
  switch (value) {
    case "high_value":
    case "standard":
    case "low_value":
      return value;
    default:
      return "standard";
  }
}

export function deriveRecommendedImportanceTier(
  input: Omit<ConversationImportanceInput, "importanceTierOverride">,
): ImportanceTier {
  // AI classification used assistively — only trusted above confidence threshold
  // or when human-overridden. Below threshold, fall through to proven heuristics.
  const isHumanOverride = input.classificationSource === "human_override";
  const confidence = input.classificationConfidence ?? 0;
  const trustClassification = isHumanOverride || confidence >= CLASSIFICATION_TRUST_THRESHOLD;

  if (input.channelType && trustClassification) {
    switch (input.channelType) {
      case "client_delivery":
      case "client_support":
        return "high_value";
      case "internal_social":
      case "automated":
        return "low_value";
      case "internal_engineering":
      case "internal_operations":
        return "standard";
      // "unclassified" falls through to heuristics below
    }
  }

  // Existing heuristics (fallback when no classification)
  if ((input.clientUserIds ?? []).length > 0) {
    return "high_value";
  }

  const normalizedName = normalizeChannelName(input.channelName);
  const isLowSignalName = config.LOW_SIGNAL_CHANNEL_NAMES.some(
    (name) => normalizeChannelName(name) === normalizedName,
  );

  if (
    input.conversationType === "public_channel" &&
    isLowSignalName
  ) {
    return "low_value";
  }

  return "standard";
}

export function resolveEffectiveImportanceTier(
  input: ConversationImportanceInput,
): ImportanceTier {
  const override = normalizeImportanceTierOverride(input.importanceTierOverride);
  if (override !== "auto") {
    return override;
  }

  return deriveRecommendedImportanceTier(input);
}

export function resolveConversationImportance(
  input: ConversationImportanceInput,
): ConversationImportanceResolution {
  const importanceTierOverride = normalizeImportanceTierOverride(
    input.importanceTierOverride,
  );
  const recommendedImportanceTier = deriveRecommendedImportanceTier(input);

  return {
    importanceTierOverride,
    recommendedImportanceTier,
    effectiveImportanceTier:
      importanceTierOverride === "auto"
        ? recommendedImportanceTier
        : importanceTierOverride,
  };
}

export function tierAllowsRoutineMessageAnalysis(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsRoutineChannelSummary(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsMomentumThreadRollups(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsThreadBootstrap(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsLeadershipHeuristics(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsResolvedHistory(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierAllowsRoutineThreadInsight(
  tier: ImportanceTier,
): boolean {
  return tier !== "low_value";
}

export function tierRequiresRiskOnlyMonitoring(
  tier: ImportanceTier,
): boolean {
  return tier === "low_value";
}

export function getRiskOnlyMonitoringNotice(): string {
  return "Risk-only monitoring is enabled for this low-signal channel. Routine chatter is stored for context, but PulseBoard will only surface severe escalation or policy-risk attention here.";
}

export function getThreadRollupThresholdsForTier(
  tier: ImportanceTier,
  input: {
    replyThreshold: number;
    hotReplyThreshold: number;
  },
): {
  replyThreshold: number;
  hotReplyThreshold: number;
} {
  if (tier === "high_value") {
    return {
      replyThreshold: Math.max(3, input.replyThreshold - 2),
      hotReplyThreshold: Math.max(3, input.hotReplyThreshold - 1),
    };
  }

  return input;
}
