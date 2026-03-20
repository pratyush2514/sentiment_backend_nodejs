import { config } from "../config.js";

const DEFAULT_AUTOMATION_KEYWORDS = [
  "error",
  "errors",
  "alert",
  "alerts",
  "incident",
  "incidents",
  "monitor",
  "monitoring",
  "n8n",
] as const;

function normalizeChannelName(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "");
}

export function allowsAutomatedMessageIngestion(
  channelName: string | null | undefined,
): boolean {
  const normalized = normalizeChannelName(channelName);
  if (!normalized) {
    return false;
  }

  const keywords = config.AUTOMATION_CHANNEL_KEYWORDS ?? DEFAULT_AUTOMATION_KEYWORDS;
  return keywords.some((keyword) =>
    normalized.includes(keyword),
  );
}
