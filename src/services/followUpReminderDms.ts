import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { getSlackClient } from "./slackClientFactory.js";

const log = logger.child({ service: "followUpReminderDms" });

export async function clearFollowUpReminderDms(
  workspaceId: string,
  itemId: string,
): Promise<void> {
  const oldRefs = await db.getFollowUpDmRefs(itemId);
  if (oldRefs.length === 0) {
    return;
  }

  try {
    const slack = await getSlackClient(workspaceId);
    for (const ref of oldRefs) {
      try {
        await slack.deleteMessage(ref.dmChannelId, ref.messageTs);
      } catch {
        // Messages may already be gone because of retention or manual cleanup.
      }
    }
  } catch (err) {
    log.warn({ err, itemId }, "Failed to get Slack client for follow-up DM cleanup");
  } finally {
    await db.clearFollowUpDmRefs(itemId);
  }
}
