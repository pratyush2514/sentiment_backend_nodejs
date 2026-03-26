/**
 * Intent Continuation Tracking
 *
 * Detects when a message indicates completion of a tracked obligation
 * and auto-resolves the related follow-up item.
 *
 * Signals:
 * - Explicit completion phrases: "done", "sent", "fixed", "completed"
 * - File attachment in thread with open follow-up (implies delivery)
 * - Reply from the assigned owner referencing the task
 */

import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { persistCanonicalChannelState } from "./canonicalChannelState.js";
import { backPropagateFollowUpResolution } from "./meetingObligationBridge.js";

const log = logger.child({ service: "intentContinuation" });

// ─── Completion signal patterns ─────────────────────────────────────────────

const COMPLETION_PATTERNS = [
  /\b(done|completed|finished|shipped|deployed|released|merged)\b/i,
  /\b(sent|shared|forwarded|attached|uploaded) (it|the|this|that|docs|document|file|link|report|timeline|update|design|mockup)/i,
  /\b(here('?s| is| are) the|attached (is|the|here))/i,
  /\b(fixed|resolved|sorted|handled|taken care of)\b/i,
  /\ball (set|done|good|ready)\b/i,
  /\bthis (is|should be) (done|ready|complete|fixed)\b/i,
  /\bjust (sent|shared|pushed|submitted|completed|finished)\b/i,
  /\b(wrapped up|closed out|knocked out|got it done)\b/i,
];

const NEGATION_PREFIXES = [
  /\bnot (yet |really )?(done|completed|finished|sent|fixed)/i,
  /\bhasn'?t been (done|completed|sent|fixed)/i,
  /\bstill (working|pending|waiting|need)/i,
  /\bnot yet\b/i,
  /\bwill (do|send|fix|complete|finish)/i,
  /\bgoing to (do|send|fix)/i,
  /\bplan to (do|send|fix)/i,
];

/**
 * Check if a message signals completion of a tracked item.
 * Returns true if the message indicates something was completed.
 */
function isCompletionSignal(text: string): boolean {
  const normalized = text.trim().toLowerCase();

  // Short messages less likely to be completion signals (avoid "done" = "done reading this message")
  // Exception: very short explicit completions like "done", "sent it"
  if (normalized.length < 3) return false;

  // Check for negation first — "not done yet" is not a completion signal
  if (NEGATION_PREFIXES.some((p) => p.test(normalized))) return false;

  // Check for completion patterns
  return COMPLETION_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Check if a message with file attachments in a thread with open follow-ups
 * implies delivery (e.g., sharing the requested document).
 */
function hasFileDeliverySignal(hasFiles: boolean, isInThread: boolean): boolean {
  return hasFiles && isInThread;
}

// ─── Core resolution logic ──────────────────────────────────────────────────

export interface IntentContinuationInput {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  userId: string;
  text: string;
  hasFiles: boolean;
}

export interface IntentContinuationResult {
  resolved: string[]; // follow-up item IDs that were auto-resolved
  reason: string;
}

/**
 * Attempt to auto-resolve follow-up items when a message signals completion.
 *
 * Strategy:
 * 1. If message is a thread reply with completion signal → resolve follow-ups in that thread
 * 2. If message is from an assigned owner with completion signal → resolve their obligations
 * 3. If file is shared in a thread with open follow-ups → resolve the follow-up
 */
export async function checkIntentContinuation(
  input: IntentContinuationInput,
): Promise<IntentContinuationResult> {
  const { workspaceId, channelId, threadTs, userId, text, hasFiles } = input;
  const resolved: string[] = [];

  const isCompletion = isCompletionSignal(text);
  const isFileDelivery = hasFileDeliverySignal(hasFiles, !!threadTs);

  if (!isCompletion && !isFileDelivery) {
    return { resolved: [], reason: "no_signal" };
  }

  try {
    // Find open follow-ups in this channel that could be resolved
    const openItems = await db.listOpenFollowUpItems(workspaceId, 50);
    const channelItems = openItems.filter((item) => item.channel_id === channelId) as Array<
      typeof openItems[number] & { meeting_obligation_id?: string | null }
    >;

    if (channelItems.length === 0) {
      return { resolved: [], reason: "no_open_items" };
    }

    for (const item of channelItems) {
      let shouldResolve = false;
      let reason = "";

      // Case 1: Thread reply matches the follow-up's source thread
      if (threadTs && item.source_thread_ts === threadTs && isCompletion) {
        shouldResolve = true;
        reason = "completion_signal_in_thread";
      }

      // Case 2: Reply from the primary responder with completion signal
      if (
        isCompletion &&
        item.primary_responder_ids?.includes(userId)
      ) {
        shouldResolve = true;
        reason = "owner_completion_signal";
      }

      // Case 3: File shared in the thread of a follow-up (implies delivery)
      if (
        isFileDelivery &&
        threadTs &&
        item.source_thread_ts === threadTs
      ) {
        shouldResolve = true;
        reason = "file_delivery_in_thread";
      }

      if (shouldResolve) {
        try {
          await db.resolveFollowUpItem({
            itemId: item.id,
            resolvedMessageTs: input.messageTs,
            resolutionReason: "reply",
            resolutionScope: threadTs ? "thread" : "channel",
            resolvedByUserId: userId,
          });

          // Back-propagate to meeting obligation if linked
          if (item.meeting_obligation_id) {
            await backPropagateFollowUpResolution(item.id, item.meeting_obligation_id);
          }

          resolved.push(item.id);

          log.info(
            {
              workspaceId,
              channelId,
              followUpId: item.id,
              reason,
              userId,
              meetingObligationId: item.meeting_obligation_id ?? null,
            },
            "Auto-resolved follow-up via intent continuation",
          );
        } catch (err) {
          log.warn(
            { followUpId: item.id, err: err instanceof Error ? err.message : "unknown" },
            "Failed to auto-resolve follow-up",
          );
        }
      }
    }
  } catch (err) {
    log.warn(
      { workspaceId, channelId, err: err instanceof Error ? err.message : "unknown" },
      "Intent continuation check failed",
    );
  }

  // Reactive health refresh after auto-resolving follow-ups
  if (resolved.length > 0) {
    persistCanonicalChannelState(workspaceId, channelId).catch(() => {
      // Non-fatal
    });
  }

  return {
    resolved,
    reason: resolved.length > 0 ? "auto_resolved" : "no_match",
  };
}
