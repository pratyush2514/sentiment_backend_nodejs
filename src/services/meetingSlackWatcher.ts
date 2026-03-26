import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "meetingSlackWatcher" });

/**
 * Check if a new Slack message provides evidence of progress on
 * open meeting obligations in the same channel.
 *
 * Piggybacks on the existing message.ingest pipeline — no new event loop.
 * Called from messageHandler after standard follow-up detection.
 */
export async function checkMeetingObligationProgress(
  workspaceId: string,
  channelId: string,
  messageText: string,
  userId: string,
  messageTs: string,
): Promise<void> {
  const openObligations = await db.getOpenMeetingObligationsForChannel(workspaceId, channelId);

  if (openObligations.length === 0) return;

  const lowerText = messageText.toLowerCase();

  for (const obligation of openObligations) {
    // Check if the message author is the obligation owner
    const isOwner = obligation.owner_user_id === userId;

    // Check if message text contains keywords from the obligation title
    const titleWords = obligation.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3); // Only match on meaningful words

    const matchingWords = titleWords.filter((word) => lowerText.includes(word));
    const matchRatio = titleWords.length > 0 ? matchingWords.length / titleWords.length : 0;

    // Evidence threshold: owner posting + any keyword match, OR non-owner with strong keyword match
    const isEvidence = (isOwner && matchRatio > 0.2) || matchRatio > 0.5;

    if (isEvidence) {
      const snippet = messageText.slice(0, 200);
      await db.appendMeetingObligationEvidence(obligation.id, {
        messageTs,
        userId,
        snippet,
      });

      log.info(
        {
          workspaceId,
          channelId,
          obligationId: obligation.id,
          obligationTitle: obligation.title,
          isOwner,
          matchRatio,
        },
        "Meeting obligation progress evidence detected",
      );
    }
  }
}
