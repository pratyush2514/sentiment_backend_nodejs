import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { processFollowUpsForMessage } from "./followUpMonitor.js";

const log = logger.child({ service: "followUpReconcile" });

export async function reconcileMissingFollowUps(options: {
  workspaceId?: string;
  requesterUserId?: string;
  channelId?: string;
  limit?: number;
  hoursBack?: number;
} = {}): Promise<number> {
  const candidates = await db.listRecentMessagesMissingFollowUps(options);
  let processed = 0;

  for (const candidate of candidates) {
    try {
      await processFollowUpsForMessage({
        workspaceId: candidate.workspace_id,
        channelId: candidate.channel_id,
        ts: candidate.ts,
        threadTs: candidate.thread_ts,
        userId: candidate.user_id,
        text: candidate.normalized_text ?? candidate.text,
        rawText: candidate.text,
      });
      processed += 1;
    } catch (err) {
      log.warn(
        {
          err,
          workspaceId: candidate.workspace_id,
          channelId: candidate.channel_id,
          messageTs: candidate.ts,
        },
        "Failed to reconcile follow-up candidate",
      );
    }
  }

  return processed;
}
