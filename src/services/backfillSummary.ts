import { config } from "../config.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { persistCanonicalChannelState } from "./canonicalChannelState.js";
import { createEmbeddingProvider } from "./embeddingProvider.js";
import { eventBus } from "./eventBus.js";
import { backfillSummarize, estimateTokens } from "./summarizer.js";

const log = logger.child({ service: "backfillSummary" });

export interface MaterializeBackfillSummaryInput {
  workspaceId: string;
  channelId: string;
  windowDays?: number;
  publishEvent?: boolean;
}

export interface MaterializeBackfillSummaryResult {
  summary: string;
  keyDecisions: string[];
  messageCount: number;
  summaryType: "llm" | "no_recent_messages";
}

export async function materializeBackfillSummary({
  workspaceId,
  channelId,
  windowDays = config.SUMMARY_WINDOW_DAYS,
  publishEvent = true,
}: MaterializeBackfillSummaryInput): Promise<MaterializeBackfillSummaryResult> {
  const result = await backfillSummarize(workspaceId, channelId, windowDays);

  if (!result) {
    const recentMessages = await db.getMessagesInWindow(
      workspaceId,
      channelId,
      windowDays,
      null,
      1,
    );

    if (recentMessages.length === 0) {
      const summary = `No recent conversation in the last ${windowDays} day${windowDays === 1 ? "" : "s"}.`;
      await db.upsertChannelState(workspaceId, channelId, {
        running_summary: summary,
        key_decisions_json: [],
      });
      await persistCanonicalChannelState(workspaceId, channelId);
      await db.resetRollupState(workspaceId, channelId);

      if (publishEvent) {
        eventBus.createAndPublish("rollup_updated", workspaceId, channelId, {
          rollupType: "backfill",
        });
      }

      log.info(
        { channelId, windowDays },
        "Backfill summarization found no recent messages within the analysis window",
      );

      return {
        summary,
        keyDecisions: [],
        messageCount: 0,
        summaryType: "no_recent_messages",
      };
    }

    const messageCount = await db.getMessageCount(workspaceId, channelId);
    log.warn(
      { channelId, messageCount, windowDays },
      "Backfill summarization failed despite recent channel messages being present",
    );
    throw new Error(`Backfill rollup failed for ${channelId}`);
  }

  const embeddingProvider = createEmbeddingProvider();
  let embedding: number[] | null = null;

  if (embeddingProvider) {
    try {
      const embResult = await embeddingProvider.embed(result.summary);
      embedding = embResult.embedding;
    } catch (err) {
      log.warn({ err, channelId }, "Embedding failed for backfill summary");
    }
  }

  await db.insertContextDocument({
    workspaceId,
    channelId,
    docType: "backfill_rollup",
    content: result.summary,
    tokenCount: estimateTokens(result.summary),
    embedding,
    sourceTsStart: result.sourceTsStart,
    sourceTsEnd: result.sourceTsEnd,
    sourceThreadTs: null,
    messageCount: result.messageCount,
  });

  await db.upsertChannelState(workspaceId, channelId, {
    running_summary: result.summary,
    key_decisions_json: result.keyDecisions,
  });
  await persistCanonicalChannelState(workspaceId, channelId);
  await db.resetRollupState(workspaceId, channelId);

  if (publishEvent) {
    eventBus.createAndPublish("rollup_updated", workspaceId, channelId, {
      rollupType: "backfill",
    });
  }

  log.info(
    { channelId, decisions: result.keyDecisions.length, messageCount: result.messageCount },
    "Backfill rollup complete",
  );

  return {
    summary: result.summary,
    keyDecisions: result.keyDecisions,
    messageCount: result.messageCount,
    summaryType: "llm",
  };
}
