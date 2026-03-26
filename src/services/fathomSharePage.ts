import { logger } from "../utils/logger.js";
import {
  cleanMeetingText,
  extractShareIdFromUrl,
  truncateMeetingText,
} from "./fathomMeetingUtils.js";

const log = logger.child({ service: "fathomSharePage" });

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const META_TAG_PATTERN = /<meta\b([^>]+)>/gi;
const TITLE_TAG_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const MAX_HIGHLIGHTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const GENERIC_TITLES = new Set(["fathom", "fathom video"]);

const SUMMARY_CANDIDATE_KEYS = [
  "summary",
  "description",
  "defaultSummary",
  "markdownFormatted",
  "markdown_formatted",
  "text",
  "meetingSummary",
];

const TITLE_CANDIDATE_KEYS = ["title", "name", "meetingTitle"];
const START_DATE_KEYS = [
  "recordingStartTime",
  "recording_start_time",
  "startedAt",
  "startDate",
  "scheduledStartTime",
  "scheduled_start_time",
];
const DURATION_KEYS = ["durationSeconds", "duration", "runtime", "lengthSeconds"];
const HIGHLIGHT_KEYS = ["highlights", "keyTakeaways", "takeaways", "topics"];

interface FetchSharePageOptions {
  fallbackStartedAt?: string | null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "));
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const cleaned = cleanMeetingText(stripHtml(value).replace(/\s+/g, " ").trim());
  return cleaned.length > 0 ? cleaned : null;
}

function extractAttributeValue(tagAttributes: string, attributeName: string): string | null {
  const pattern = new RegExp(
    `${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tagAttributes.match(pattern);
  return (
    match?.[2] ??
    match?.[3] ??
    match?.[4] ??
    null
  );
}

function extractMetaContent(
  html: string,
  attributeName: "property" | "name",
  attributeValue: string,
): string | null {
  for (const match of html.matchAll(META_TAG_PATTERN)) {
    const attributes = match[1];
    const currentValue = extractAttributeValue(attributes, attributeName);
    if (currentValue?.toLowerCase() !== attributeValue.toLowerCase()) {
      continue;
    }
    return normalizeText(extractAttributeValue(attributes, "content"));
  }

  return null;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(TITLE_TAG_PATTERN);
  return normalizeText(match?.[1] ?? null);
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function collectJsonCandidates(html: string): unknown[] {
  const candidates: unknown[] = [];

  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    const attributes = match[1] ?? "";
    const content = (match[2] ?? "").trim();
    if (!content) {
      continue;
    }

    const scriptType = extractAttributeValue(attributes, "type")?.toLowerCase() ?? "";
    const id = extractAttributeValue(attributes, "id")?.toLowerCase() ?? "";

    if (
      scriptType === "application/ld+json" ||
      scriptType === "application/json" ||
      id.includes("__next_data__") ||
      content.startsWith("{") ||
      content.startsWith("[")
    ) {
      const parsed = safeJsonParse(content);
      if (parsed !== null) {
        candidates.push(parsed);
      }
    }
  }

  return candidates;
}

function findFirstString(
  value: unknown,
  keys: readonly string[],
): string | null {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string") {
        const normalized = normalizeText(child);
        if (normalized) {
          return normalized;
        }
      }
      queue.push(child);
    }
  }

  return null;
}

function parseIsoDurationToSeconds(value: string): number | null {
  const match = value.match(
    /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i,
  );
  if (!match) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function findFirstDurationSeconds(value: unknown): number | null {
  const wanted = new Set(DURATION_KEYS.map((key) => key.toLowerCase()));
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase())) {
        if (typeof child === "number" && Number.isFinite(child) && child > 0) {
          return Math.round(child);
        }
        if (typeof child === "string") {
          const duration = parseIsoDurationToSeconds(child);
          if (duration) {
            return duration;
          }
        }
      }
      queue.push(child);
    }
  }

  return null;
}

function findFirstDateString(value: unknown): string | null {
  const wanted = new Set(START_DATE_KEYS.map((key) => key.toLowerCase()));
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string") {
        const parsed = Date.parse(child);
        if (Number.isFinite(parsed)) {
          return new Date(parsed).toISOString();
        }
      }
      queue.push(child);
    }
  }

  return null;
}

function findStringArray(
  value: unknown,
  keys: readonly string[],
): string[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && Array.isArray(child)) {
        const strings = child
          .map((entry) => {
            if (typeof entry === "string") {
              return normalizeText(entry);
            }
            if (entry && typeof entry === "object") {
              return findFirstString(entry, ["text", "title", "description"]);
            }
            return null;
          })
          .filter((entry): entry is string => Boolean(entry))
          .slice(0, MAX_HIGHLIGHTS);

        if (strings.length > 0) {
          return strings;
        }
      }
      queue.push(child);
    }
  }

  return [];
}

function extractVisibleTextSummary(
  html: string,
  title: string | null,
): string | null {
  const visibleText = stripHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );

  const candidates = visibleText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 32)
    .filter((line) => (title ? line.toLowerCase() !== title.toLowerCase() : true))
    .filter(
      (line) =>
        !/^(privacy|terms|cookies|sign in|log in|view in fathom|share|copy link)/i.test(
          line,
        ),
    );

  if (candidates.length === 0) {
    return null;
  }

  return truncateMeetingText(candidates.slice(0, 3).join(" "), 600);
}

export function parseFathomSharePageHtml(
  html: string,
  shareUrl: string,
  options?: FetchSharePageOptions,
): Record<string, unknown> | null {
  const shareId = extractShareIdFromUrl(shareUrl);
  if (!shareId) {
    return null;
  }

  const jsonCandidates = collectJsonCandidates(html);
  const titleFromJson = jsonCandidates
    .map((candidate) => findFirstString(candidate, TITLE_CANDIDATE_KEYS))
    .find((value): value is string => Boolean(value));
  const summaryFromJson = jsonCandidates
    .map((candidate) => findFirstString(candidate, SUMMARY_CANDIDATE_KEYS))
    .find((value): value is string => Boolean(value));
  const startedAtFromJson = jsonCandidates
    .map((candidate) => findFirstDateString(candidate))
    .find((value): value is string => Boolean(value));
  const durationFromJson = jsonCandidates
    .map((candidate) => findFirstDurationSeconds(candidate))
    .find((value): value is number => typeof value === "number" && value > 0) ?? null;
  const highlightsFromJson = jsonCandidates
    .map((candidate) => findStringArray(candidate, HIGHLIGHT_KEYS))
    .find((value) => value.length > 0) ?? [];

  const title =
    titleFromJson ??
    extractMetaContent(html, "property", "og:title") ??
    extractMetaContent(html, "name", "twitter:title") ??
    extractTitleTag(html);
  const summary =
    summaryFromJson ??
    extractMetaContent(html, "property", "og:description") ??
    extractMetaContent(html, "name", "description") ??
    extractMetaContent(html, "name", "twitter:description") ??
    extractVisibleTextSummary(html, title);
  const startedAt =
    startedAtFromJson ??
    extractMetaContent(html, "property", "article:published_time") ??
    options?.fallbackStartedAt ??
    null;
  const normalizedTitle = title?.toLowerCase() ?? null;
  const hasGenericTitleOnly =
    normalizedTitle !== null &&
    GENERIC_TITLES.has(normalizedTitle) &&
    !summary;

  if ((!title && !summary) || hasGenericTitleOnly) {
    return null;
  }

  return {
    meetingSource: "shared_link",
    title: title ?? `Fathom meeting ${shareId}`,
    shareUrl,
    recordingStartTime: startedAt,
    durationSeconds: durationFromJson,
    defaultSummary: summary
      ? {
          markdownFormatted: summary,
        }
      : undefined,
    highlights: highlightsFromJson,
  };
}

export async function fetchMeetingFromSharePage(
  shareUrl: string,
  options?: FetchSharePageOptions,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(shareUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "PulseBoard/1.0 (+shared-link-import)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn({ shareUrl, status: response.status }, "Fathom share page fetch returned non-OK response");
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      log.warn({ shareUrl, contentType }, "Fathom share page did not return HTML");
      return null;
    }

    const html = await response.text();
    return parseFathomSharePageHtml(html, shareUrl, options);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn({ shareUrl, err: errMsg }, "Failed to fetch Fathom share page");
    return null;
  }
}
