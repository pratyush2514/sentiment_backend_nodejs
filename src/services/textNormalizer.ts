import * as emoji from "node-emoji";
import { MAX_NORMALIZED_TEXT_LENGTH } from "../constants.js";

const MAX_LENGTH = MAX_NORMALIZED_TEXT_LENGTH;

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

  // Step 3: Clean URLs <https://example.com|label> → [link]
  text = text.replace(/<(https?:\/\/[^>|]+)(\|[^>]+)?>/g, "[link]");

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
