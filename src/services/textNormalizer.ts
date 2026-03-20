import * as emoji from "node-emoji";
import { MAX_NORMALIZED_TEXT_LENGTH } from "../constants.js";

const MAX_LENGTH = MAX_NORMALIZED_TEXT_LENGTH;

// ─── Link type inference ────────────────────────────────────────────────────

export interface LinkMetadata {
  url: string;
  domain: string;
  label?: string;
  linkType: "pr" | "issue" | "repo" | "doc" | "design" | "task" | "link";
}

function inferLinkType(url: string, domain: string): LinkMetadata["linkType"] {
  const lower = domain.toLowerCase();
  const path = url.toLowerCase();

  if (lower.includes("github.com") || lower.includes("gitlab.com") || lower.includes("bitbucket.org")) {
    if (/\/pull\/|\/merge_requests\/|\/pull-requests\//.test(path)) return "pr";
    if (/\/issues\//.test(path)) return "issue";
    return "repo";
  }
  if (lower.includes("docs.google.com") || lower.includes("notion.so") || lower.includes("confluence")) return "doc";
  if (lower.includes("figma.com")) return "design";
  if (lower.includes("linear.app") || lower.includes("jira") || lower.includes("asana.com") || lower.includes("trello.com")) return "task";
  return "link";
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Extract link metadata from raw Slack message text.
 * Parses `<https://...|label>` tokens and infers link type from domain + path.
 */
export function extractLinks(rawText: string): LinkMetadata[] {
  const linkRegex = /<(https?:\/\/[^>|]+)(\|([^>]+))?>/g;
  const links: LinkMetadata[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(rawText)) !== null) {
    const url = match[1];
    const label = match[3] || undefined;
    const domain = extractDomain(url);
    links.push({
      url,
      domain,
      label,
      linkType: inferLinkType(url, domain),
    });
  }

  return links;
}

// ─── Text normalization pipeline ────────────────────────────────────────────

/**
 * 8-step text normalization pipeline for Slack messages.
 * Preserves sentiment signals (caps, punctuation, exclamation).
 * Does NOT lowercase, stem, or remove stopwords.
 */
export function normalizeText(raw: string): string {
  if (!raw || !raw.trim()) return "";

  let text = raw;

  // Step 1: Strip user mentions <@U123ABC>
  text = text.replace(/<@[A-Z0-9]+>/gi, "");

  // Step 2: Resolve channel links <#C123|general> → #general
  text = text.replace(/<#[A-Z0-9]+\|([^>]+)>/gi, "#$1");

  // Step 3: Replace URLs with type-aware link markers for richer LLM context
  text = text.replace(/<(https?:\/\/[^>|]+)(\|([^>]+))?>/g, (_match, url: string, _pipe: string, label: string | undefined) => {
    const domain = extractDomain(url);
    const linkType = inferLinkType(url, domain);
    const typeTag = linkType !== "link" ? `:${linkType}` : "";
    const labelTag = label ? ` "${label}"` : "";
    return `[link${typeTag} ${domain}${labelTag}]`;
  });

  // Step 4: Convert formatting to semantic markers — preserve sarcasm signals
  text = text.replace(/\*([^*]*)\*/g, "[emphasis: $1]"); // bold → emphasis marker
  text = text.replace(/~([^~]*)~/g, "[strikethrough: $1]"); // strikethrough → sarcasm marker
  text = text.replace(/```[^`]*```/gs, (match) => match.slice(3, -3)); // code blocks
  text = text.replace(/`([^`]*)`/g, "$1"); // inline code

  // Step 5: Convert emoji shortcodes to text (:thumbsup: → thumbsup)
  text = emoji.unemojify(text); // Convert unicode emoji to shortcodes first
  text = text.replace(/:([a-zA-Z0-9_+-]+):/g, "$1"); // Strip colons from shortcodes

  // Step 6: Preserve sentiment signals — NO-OP
  // Intentionally do NOT lowercase, remove !, ?, or caps

  // Step 7: Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Step 8: Truncate to MAX_LENGTH at word boundary
  if (text.length > MAX_LENGTH) {
    const cutoff = text.lastIndexOf(" ", MAX_LENGTH);
    text = cutoff > 0 ? text.slice(0, cutoff) : text.slice(0, MAX_LENGTH);
  }

  return text;
}

// ─── Context builders for LLM ───────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build a text appendix describing file attachments for LLM context.
 * Includes file name/title, type, and human-readable size — no binary data.
 */
export function buildFileContext(
  files?: Array<{ name: string; title?: string; filetype?: string; size?: number }> | null,
): string {
  if (!files || files.length === 0) return "";
  const descriptions = files.map((f) => {
    const label = f.title || f.name;
    const typePart = f.filetype ? ` (${f.filetype}` : "";
    const sizePart = f.size ? `, ${formatBytes(f.size)}` : "";
    const closeParen = typePart ? ")" : "";
    return `[shared file: "${label}"${typePart}${sizePart}${closeParen}]`;
  });
  return "\n" + descriptions.join("\n");
}

/**
 * Build a text appendix describing shared links for LLM context.
 * Includes domain, link type, and optional label.
 */
export function buildLinkContext(
  links?: LinkMetadata[] | null,
): string {
  if (!links || links.length === 0) return "";
  const descriptions = links.map((l) => {
    const typeTag = l.linkType !== "link" ? `:${l.linkType}` : "";
    const labelTag = l.label ? ` "${l.label}"` : "";
    return `[link${typeTag} ${l.domain}${labelTag}]`;
  });
  return "\n" + descriptions.join("\n");
}
