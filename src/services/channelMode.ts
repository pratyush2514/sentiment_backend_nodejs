import type {
  ChannelMode,
  ChannelModeOverride,
  ConversationType,
} from "../types/database.js";

export interface ChannelModeInput {
  channelName?: string | null;
  conversationType?: ConversationType | null;
  botMessageRatio?: number | null;
  automationSignalRatio?: number | null;
  channelModeOverride?: ChannelModeOverride | null;
}

export interface ChannelModeResolution {
  channelModeOverride: ChannelModeOverride;
  recommendedChannelMode: ChannelMode;
  effectiveChannelMode: ChannelMode;
}

const AUTOMATION_NAME_RE =
  /\b(error|errors|incident|incidents|alert|alerts|log|logs|monitor|monitoring|ops|ops-alerts|status|n8n|bot|automation|failures?)\b/i;

function normalizeChannelName(name?: string | null): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[_\s-]+/g, " ");
}

export function normalizeChannelModeOverride(
  value?: string | null,
): ChannelModeOverride {
  switch (value) {
    case "collaboration":
    case "automation":
    case "mixed":
    case "auto":
      return value;
    default:
      return "auto";
  }
}

export function normalizeChannelMode(value?: string | null): ChannelMode {
  switch (value) {
    case "collaboration":
    case "automation":
    case "mixed":
      return value;
    default:
      return "collaboration";
  }
}

export function deriveRecommendedChannelMode(
  input: Omit<ChannelModeInput, "channelModeOverride">,
): ChannelMode {
  if (
    input.conversationType === "dm" ||
    input.conversationType === "group_dm"
  ) {
    return "collaboration";
  }

  const normalizedName = normalizeChannelName(input.channelName);
  const hasAutomationName = AUTOMATION_NAME_RE.test(normalizedName);
  const botMessageRatio = input.botMessageRatio ?? 0;
  const automationSignalRatio = input.automationSignalRatio ?? 0;

  if (
    botMessageRatio >= 0.75 ||
    automationSignalRatio >= 0.75 ||
    (hasAutomationName && (botMessageRatio >= 0.4 || automationSignalRatio >= 0.4))
  ) {
    return "automation";
  }

  if (
    hasAutomationName ||
    botMessageRatio >= 0.25 ||
    automationSignalRatio >= 0.25
  ) {
    return "mixed";
  }

  return "collaboration";
}

export function resolveEffectiveChannelMode(
  input: ChannelModeInput,
): ChannelMode {
  const override = normalizeChannelModeOverride(input.channelModeOverride);
  if (override !== "auto") {
    return override;
  }

  return deriveRecommendedChannelMode(input);
}

export function resolveChannelMode(
  input: ChannelModeInput,
): ChannelModeResolution {
  const channelModeOverride = normalizeChannelModeOverride(
    input.channelModeOverride,
  );
  const recommendedChannelMode = deriveRecommendedChannelMode(input);

  return {
    channelModeOverride,
    recommendedChannelMode,
    effectiveChannelMode:
      channelModeOverride === "auto"
        ? recommendedChannelMode
        : channelModeOverride,
  };
}
