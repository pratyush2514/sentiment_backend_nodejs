import { z } from "zod/v4";
import { config } from "../config.js";
import { buildMeetingExtractionPrompt } from "../prompts/meetingExtraction.js";
import { logger } from "../utils/logger.js";
import { parseAndValidate, STRICT_RETRY_SUFFIX } from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import type { LLMRawResult } from "./llmProviders.js";
import type { MeetingRow } from "../types/database.js";

const log = logger.child({ service: "meetingExtractor" });

// ─── Output Schema ───────────────────────────────────────────────────────────

const ObligationSchema = z.object({
  type: z.enum(["action_item", "decision", "commitment", "question", "risk", "next_step"]),
  title: z.string().min(1).max(300),
  description: z.string().max(500).nullable().optional(),
  ownerName: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  sourceContext: z.string().max(400).nullable().optional(),
});

const MeetingExtractionSchema = z.object({
  obligations: z.array(ObligationSchema).max(30),
  meetingSentiment: z.enum(["positive", "neutral", "concerned", "tense"]),
  riskSignals: z.array(z.string()).max(5),
});

export type MeetingExtractionResult = z.infer<typeof MeetingExtractionSchema>;
export type ExtractedObligation = z.infer<typeof ObligationSchema>;

// ─── Extraction ──────────────────────────────────────────────────────────────

export async function extractMeetingObligations(
  meeting: MeetingRow,
): Promise<{ result: MeetingExtractionResult; raw: LLMRawResult } | null> {
  const provider = createLLMProvider();
  const model = config.LLM_MODEL_THREAD; // Use thread-tier model for nuanced extraction

  const participantNames = (meeting.participants_json ?? []).map((p) => p.name);

  const { system, user } = buildMeetingExtractionPrompt({
    title: meeting.title,
    durationMinutes: meeting.duration_seconds ? Math.round(meeting.duration_seconds / 60) : null,
    participantNames,
    fathomSummary: meeting.fathom_summary,
    fathomActionItems: meeting.fathom_action_items_json ?? [],
    transcript: meeting.transcript_text,
    maxTranscriptTokens: config.FATHOM_MAX_TRANSCRIPT_TOKENS,
    currentDate: new Date().toISOString().split("T")[0],
  });

  log.info(
    { meetingId: meeting.id, model, hasTranscript: Boolean(meeting.transcript_text) },
    "Running meeting obligation extraction",
  );

  // First attempt
  const rawResult = await provider.chat(system, user, model);
  const first = parseAndValidate(rawResult.content, MeetingExtractionSchema);
  if (first.success) {
    log.info(
      { meetingId: meeting.id, obligationCount: first.data.obligations.length },
      "Meeting extraction succeeded",
    );
    return { result: first.data, raw: rawResult };
  }

  log.warn(
    { meetingId: meeting.id, error: first.error },
    "Meeting extraction validation failed, retrying",
  );

  // Retry with strict suffix
  const retryResult = await provider.chat(system + STRICT_RETRY_SUFFIX, user, model);
  const second = parseAndValidate(retryResult.content, MeetingExtractionSchema);
  if (second.success) {
    log.info(
      { meetingId: meeting.id, obligationCount: second.data.obligations.length },
      "Meeting extraction succeeded on retry",
    );
    return { result: second.data, raw: retryResult };
  }

  log.error(
    { meetingId: meeting.id, error: second.error },
    "Meeting extraction failed after retry",
  );
  return null;
}
