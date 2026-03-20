import { createHash } from "node:crypto";
import { z } from "zod/v4";

/** Strip markdown code fences that LLMs sometimes wrap JSON in */
export function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "");
  cleaned = cleaned.replace(/\n?```\s*$/, "");
  return cleaned.trim();
}

export const STRICT_RETRY_SUFFIX =
  "\n\nYour previous response was not valid JSON. Return ONLY a raw JSON object with no markdown, no code fences, no commentary. Just the JSON.";

export function summarizeRawLlmResponse(raw: string) {
  const cleaned = stripCodeFences(raw);
  const trimmed = raw.trim();

  return {
    rawResponseChars: raw.length,
    rawResponseHash: createHash("sha256").update(cleaned).digest("hex").slice(0, 16),
    rawResponseHadCodeFences: trimmed.startsWith("```"),
    rawResponseLookedLikeJson: cleaned.trimStart().startsWith("{"),
  };
}

export function parseAndValidate<T>(
  raw: string,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const cleaned = stripCodeFences(raw);
    const parsed = JSON.parse(cleaned);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: z.prettifyError(result.error) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "JSON parse failed",
    };
  }
}
