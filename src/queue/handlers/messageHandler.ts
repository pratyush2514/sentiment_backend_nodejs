import { config } from "../../config.js";
import * as db from "../../db/queries.js";
import { evaluateLLMGate } from "../../services/llmGate.js";
import { normalizeText } from "../../services/textNormalizer.js";
import { resolveUserProfile } from "../../services/userProfiles.js";
import { logger } from "../../utils/logger.js";
import { enqueueLLMAnalyze, enqueueSummaryRollup } from "../boss.js";
import type { MessageIngestJob } from "../jobTypes.js";
import type { Job } from "pg-boss";

const log = logger.child({ handler: "messageIngest" });

export async function handleMessageIngest(
  jobs: Job<MessageIngestJob>[],
): Promise<void> {
  for (const job of jobs) {
    const { workspaceId, channelId, ts, userId, text, threadTs } = job.data;

    log.debug({ jobId: job.id, channelId, ts }, "Processing message ingest");

    // Store message in database
    await db.upsertMessage(
      workspaceId,
      channelId,
      ts,
      userId,
      text,
      "realtime",
      threadTs,
    );

    // Store thread edge if this is a threaded reply
    if (threadTs && ts !== threadTs) {
      await db.upsertThreadEdge(workspaceId, channelId, threadTs, ts);
    }

    // Resolve user profile (fire-and-forget, cache-first)
    resolveUserProfile(workspaceId, userId).catch((err) => {
      const errMsg = err instanceof Error ? err.message : "unknown";
      log.warn({ userId, error: errMsg }, "User profile resolution failed during ingest");
    });

    // Update channel last event timestamp
    await db.updateChannelLastEvent(workspaceId, channelId);

    // Increment counters
    await db.incrementMessagesSinceLLM(workspaceId, channelId);
    await db.incrementMessagesSinceRollup(workspaceId, channelId);

    // Text normalization
    const normalizedText = normalizeText(text);
    await db.updateNormalizedText(workspaceId, channelId, ts, normalizedText);

    // LLM gate evaluation
    const channelState = await db.getChannelState(workspaceId, channelId);
    if (channelState) {
      const trigger = evaluateLLMGate(normalizedText, channelState, threadTs);
      if (trigger) {
        const jobId = await enqueueLLMAnalyze({
          workspaceId,
          channelId,
          triggerType: trigger,
          threadTs: threadTs ?? null,
        });
        // Only reset gating state if the job was actually enqueued
        if (jobId) {
          await db.resetLLMGatingState(workspaceId, channelId, config.LLM_COOLDOWN_SEC);
        }
      }
    }

    // Rollup trigger evaluation
    if (channelState) {
      const shouldChannelRollup =
        channelState.messages_since_last_rollup >= config.ROLLUP_MSG_THRESHOLD ||
        (channelState.messages_since_last_rollup > 0 &&
          channelState.last_rollup_at !== null &&
          Date.now() - new Date(channelState.last_rollup_at).getTime() >=
            config.ROLLUP_TIME_THRESHOLD_MIN * 60_000);

      if (shouldChannelRollup) {
        await enqueueSummaryRollup({
          workspaceId,
          channelId,
          rollupType: "channel",
        });
      }

      // Thread rollup: check if threaded reply count exceeds threshold
      if (threadTs) {
        const replyCount = await db.getThreadReplyCount(workspaceId, channelId, threadTs);
        if (replyCount >= config.ROLLUP_THREAD_REPLY_THRESHOLD) {
          await enqueueSummaryRollup({
            workspaceId,
            channelId,
            rollupType: "thread",
            threadTs,
          });
        }
      }
    }

    log.debug({ jobId: job.id, channelId, ts }, "Message ingest complete");
  }
}
