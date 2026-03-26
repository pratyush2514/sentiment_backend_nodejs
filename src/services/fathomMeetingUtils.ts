export function toIsoString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

export function getMeetingIdentifier(
  item: Record<string, unknown>,
): string | null {
  const candidates = [
    item.recording_id,
    item.recordingId,
    item.id,
    item.call_id,
    item.callId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return null;
}

export function getMeetingShareUrl(
  item: Record<string, unknown>,
): string | null {
  if (typeof item.share_url === "string" && item.share_url.length > 0) {
    return item.share_url;
  }
  if (typeof item.shareUrl === "string" && item.shareUrl.length > 0) {
    return item.shareUrl;
  }
  return null;
}

export function extractShareIdFromUrl(
  shareUrl: string | null | undefined,
): string | null {
  if (!shareUrl) {
    return null;
  }

  const match = shareUrl.match(
    /^https?:\/\/fathom\.video\/share\/([A-Za-z0-9_-]+)/i,
  );
  return match?.[1] ?? null;
}

export function extractMeetingSummaryText(
  item: Record<string, unknown>,
  fallback: string | null = null,
): string | null {
  const defaultSummary = (
    item.default_summary ??
    item.defaultSummary ??
    null
  ) as Record<string, unknown> | null;

  return (
    (defaultSummary?.markdown_formatted ??
      defaultSummary?.markdownFormatted ??
      defaultSummary?.text ??
      fallback ??
      null) as string | null
  );
}

export function cleanMeetingText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\(https?:\/\/fathom\.video[^)]*\)/g, "")
    .replace(/^##\s+/gm, "*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateMeetingText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
