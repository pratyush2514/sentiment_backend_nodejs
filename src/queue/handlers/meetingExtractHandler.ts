import { config } from "../../config.js";
import * as db from "../../db/queries.js";
import { recordIntelligenceDegradation } from "../../services/intelligenceTruth.js";
import { resolveParticipantsToSlackUsers } from "../../services/meetingChannelResolver.js";
import { extractMeetingObligations } from "../../services/meetingExtractor.js";
import { logger } from "../../utils/logger.js";
import { enqueueMeetingDigest, enqueueMeetingObligationSync } from "../boss.js";
import type { MeetingObligationDueDateSource, MeetingObligationPriority, MeetingObligationType } from "../../types/database.js";
import type { MeetingExtractJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ service: "meetingExtractHandler" });

export async function handleMeetingExtract(jobs: Job<MeetingExtractJob>[]): Promise<void> {
  for (const job of jobs) {
    await processMeetingExtract(job.data);
  }
}

async function processMeetingExtract(job: MeetingExtractJob): Promise<void> {
  const { workspaceId, meetingId } = job;

  log.info({ workspaceId, meetingId }, "Processing meeting extraction");

  const meeting = await db.getMeeting(workspaceId, meetingId);
  if (!meeting) {
    log.warn({ workspaceId, meetingId }, "Meeting not found for extraction");
    return;
  }

  if (meeting.extraction_status === "completed") {
    log.info({ workspaceId, meetingId }, "Meeting already extracted, skipping");
    return;
  }

  const shouldTriggerHistoricalSideEffects = meeting.import_mode !== "historical";
  const nextProcessingStatus =
    shouldTriggerHistoricalSideEffects && meeting.digest_enabled
      ? "digesting"
      : "completed";

  await db.updateMeetingExtractionStatus(workspaceId, meetingId, "pending");

  try {
    const extraction = await extractMeetingObligations(meeting);

    if (!extraction) {
      // LLM extraction failed — record degradation but still allow digest
      await db.updateMeetingExtractionResult(workspaceId, meetingId, {
        extractionStatus: "failed",
        processingStatus: nextProcessingStatus,
      });
      await recordIntelligenceDegradation({
        workspaceId,
        channelId: meeting.channel_id ?? "",
        scope: "meeting",
        eventType: "fathom_extraction_failed",
        severity: "medium",
        details: { meetingId, title: meeting.title },
      });

      // Still enqueue digest (will post Fathom summary without PulseBoard overlay)
      if (
        shouldTriggerHistoricalSideEffects &&
        meeting.channel_id &&
        meeting.digest_enabled
      ) {
        await enqueueMeetingDigest({ workspaceId, meetingId, channelId: meeting.channel_id });
      }
      return;
    }

    const { result, raw } = extraction;

    // Resolve participant names to Slack user IDs
    const nameToSlackId = await resolveParticipantsToSlackUsers(
      workspaceId,
      meeting.participants_json ?? [],
    );

    // Insert obligations — quality gate: filter out low-confidence extractions
    const OBLIGATION_CONFIDENCE_THRESHOLD = 0.4;
    const allObligations = result.obligations ?? [];
    const obligations = allObligations.filter((ob) => ob.confidence >= OBLIGATION_CONFIDENCE_THRESHOLD);
    const filteredCount = allObligations.length - obligations.length;

    if (filteredCount > 0) {
      log.info(
        { workspaceId, meetingId, filteredCount, threshold: OBLIGATION_CONFIDENCE_THRESHOLD },
        "Filtered low-confidence obligations from extraction",
      );
    }

    const obligationInputs = obligations.map((ob) => ({
      obligationType: ob.type as MeetingObligationType,
      title: ob.title,
      description: ob.description ?? null,
      ownerUserId: ob.ownerName
        ? (
          nameToSlackId.get(ob.ownerName) ??
          nameToSlackId.get(ob.ownerName.trim().toLowerCase()) ??
          null
        )
        : null,
      ownerName: ob.ownerName ?? null,
      dueDate: ob.dueDate ?? null,
      dueDateSource: (ob.dueDate ? "inferred" as const : null) as MeetingObligationDueDateSource | null,
      priority: ob.priority as MeetingObligationPriority,
      extractionConfidence: ob.confidence,
      sourceContext: ob.sourceContext ?? null,
    }));

    await db.insertMeetingObligations(
      workspaceId,
      meetingId,
      meeting.channel_id,
      obligationInputs,
    );

    // Track LLM cost
    await db.insertLLMCost({
      workspaceId,
      channelId: meeting.channel_id ?? "",
      llmProvider: config.LLM_PROVIDER,
      llmModel: config.LLM_MODEL_THREAD,
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      estimatedCostUsd: estimateCost(raw.promptTokens, raw.completionTokens, config.LLM_MODEL_THREAD),
      jobType: "meeting_extraction",
    });

    await db.updateMeetingExtractionResult(workspaceId, meetingId, {
      extractionStatus: "completed",
      meetingSentiment: result.meetingSentiment,
      riskSignalsJson: result.riskSignals.map((signal) => ({ signal })),
      processingStatus: nextProcessingStatus,
    });

    log.info(
      {
        workspaceId,
        meetingId,
        obligationCount: result.obligations.length,
        sentiment: result.meetingSentiment,
        riskSignalCount: result.riskSignals.length,
      },
      "Meeting extraction completed",
    );

    if (
      shouldTriggerHistoricalSideEffects &&
      meeting.channel_id &&
      meeting.digest_enabled
    ) {
      await enqueueMeetingDigest({ workspaceId, meetingId, channelId: meeting.channel_id });
    }
    if (
      shouldTriggerHistoricalSideEffects &&
      meeting.channel_id &&
      meeting.tracking_enabled &&
      !meeting.digest_enabled
    ) {
      await enqueueMeetingObligationSync({ workspaceId, meetingId });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, meetingId, err: errMsg }, "Meeting extraction failed");
    await db.updateMeetingExtractionStatus(workspaceId, meetingId, "failed");
    await db.updateMeetingProcessingStatus(workspaceId, meetingId, "failed", errMsg);
    throw err;
  }
}

function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
): number {
  // Rough cost estimates per 1M tokens
  const costs: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o": { prompt: 2.5, completion: 10.0 },
    "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
    "gemini-2.5-pro": { prompt: 1.25, completion: 10.0 },
    "gemini-2.0-flash": { prompt: 0.1, completion: 0.4 },
  };
  const rate = costs[model] ?? { prompt: 1.0, completion: 3.0 };
  return (promptTokens * rate.prompt + completionTokens * rate.completion) / 1_000_000;
}
