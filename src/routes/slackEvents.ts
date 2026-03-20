import express, { Router } from "express";
import { config } from "../config.js";
import * as db from "../db/queries.js";
import {
  getRawBody,
  verifySlackSignature,
} from "../middleware/slackSignature.js";
import {
  enqueueBackfill,
  enqueueLLMAnalyze,
  enqueueMessageIngest,
} from "../queue/boss.js";
import { allowsAutomatedMessageIngestion } from "../services/channelMessagePolicy.js";
import { resolveChannelMetadata } from "../services/channelMetadata.js";
import { eventBus } from "../services/eventBus.js";
import { emitFollowUpAlert } from "../services/followUpEvents.js";
import { reconcileFollowUpSourceEdit } from "../services/followUpMonitor.js";
import { clearFollowUpReminderDms } from "../services/followUpReminderDms.js";
import {
  getSlackClient,
  invalidateWorkspaceCache,
} from "../services/slackClientFactory.js";
import {
  buildFileContext,
  buildLinkContext,
  extractLinks,
  normalizeText,
} from "../services/textNormalizer.js";
import {
  isCandidateMessageEvent,
  isBotJoinEvent,
  isBotLeaveEvent,
  isMessageChangedEvent,
  isProcessableMessageEvent,
  isMessageDeletedEvent,
  isReactionAddedEvent,
  isReactionRemovedEvent,
} from "../types/slack.js";
import { logger } from "../utils/logger.js";
import type { FollowUpItemRow } from "../types/database.js";
import type {
  SlackPayload,
  SlackUrlVerificationPayload,
  SlackEventCallbackPayload,
} from "../types/slack.js";

export const slackEventsRouter = Router();

const log = logger.child({ route: "slackEvents" });

function resolveReopenedWorkflowState(
  item: FollowUpItemRow,
): "awaiting_primary" | "escalated" {
  if (
    item.workflow_state === "escalated" ||
    item.primary_missed_sla ||
    (item.primary_responder_ids.length === 0 &&
      item.escalation_responder_ids.length > 0)
  ) {
    return "escalated";
  }

  return "awaiting_primary";
}

async function reopenFollowUpAfterEvidenceRemoval(params: {
  workspaceId: string;
  channelId: string;
  item: FollowUpItemRow;
  actorUserId?: string | null;
  messageTs: string;
  reason: "reaction_removed" | "responder_message_deleted";
  summary: string;
}): Promise<void> {
  const workflowState = resolveReopenedWorkflowState(params.item);
  const dueAt = new Date();

  await db.reopenFollowUpItem({
    itemId: params.item.id,
    lastRequestTs: params.item.last_request_ts ?? params.item.source_message_ts,
    seriousness: params.item.seriousness,
    seriousnessScore: params.item.seriousness_score,
    reasonCodes: params.item.reason_codes,
    summary: params.item.summary,
    workflowState,
    dueAt,
    visibilityAfter: new Date(),
    nextExpectedResponseAt: dueAt,
  });
  await db.recordFollowUpEvent({
    followUpItemId: params.item.id,
    workspaceId: params.workspaceId,
    channelId: params.channelId,
    eventType: workflowState === "escalated" ? "escalated" : "reopened",
    workflowState,
    actorUserId: params.actorUserId ?? null,
    messageTs: params.messageTs,
    metadata: {
      reason: params.reason,
    },
  });
  emitFollowUpAlert({
    workspaceId: params.workspaceId,
    channelId: params.channelId,
    followUpItemId: params.item.id,
    alertType:
      params.item.seriousness === "high"
        ? "follow_up_high_priority"
        : "follow_up_opened",
    changeType: workflowState === "escalated" ? "escalated" : "reopened",
    seriousness: params.item.seriousness,
    sourceMessageTs: params.item.source_message_ts,
    threadTs: params.item.source_thread_ts,
    summary: params.summary,
  });
}

slackEventsRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  verifySlackSignature,
  async (req, res) => {
    const rawBody = getRawBody(req);

    let payload: SlackPayload;
    try {
      payload = JSON.parse(rawBody) as SlackPayload;
    } catch {
      res.status(400).send("Invalid JSON");
      return;
    }

    // Handle url_verification challenge
    if (
      payload.type === "url_verification" &&
      typeof (payload as SlackUrlVerificationPayload).challenge === "string"
    ) {
      res.status(200).json({
        challenge: (payload as SlackUrlVerificationPayload).challenge,
      });
      return;
    }

    // Handle event_callback
    if (
      payload.type === "event_callback" &&
      typeof (payload as SlackEventCallbackPayload).event === "object" &&
      (payload as SlackEventCallbackPayload).event !== null
    ) {
      const callbackPayload = payload as SlackEventCallbackPayload;
      const workspaceId = callbackPayload.team_id;
      if (!workspaceId) {
        log.warn(
          { event_id: callbackPayload.event_id },
          "Missing team_id in event callback — skipping",
        );
        res.sendStatus(200);
        return;
      }

      const event = callbackPayload.event;
      const eventId =
        callbackPayload.event_id ??
        `${event.type}:${"event_ts" in event && typeof event.event_ts === "string" ? event.event_ts : "unknown"}:${"ts" in event && typeof event.ts === "string" ? event.ts : "none"}`;

      const reservation = await db.reserveSlackEvent(
        workspaceId,
        eventId,
        event.type,
      );
      if (reservation !== "reserved") {
        res.sendStatus(200);
        return;
      }

      const markProcessed = async () => {
        await db.completeSlackEvent(workspaceId, eventId);
      };
      const finishProcessed = async () => {
        await markProcessed();
        res.sendStatus(200);
      };

      // App uninstalled from workspace → deactivate and invalidate token cache
      try {
        if (event.type === "app_uninstalled") {
          await db.deactivateWorkspace(workspaceId);
          invalidateWorkspaceCache(workspaceId);
          await finishProcessed();
          log.info({ workspaceId }, "Workspace uninstalled — deactivated");
          return;
        }

        const slack = await getSlackClient(workspaceId);
        const botUserId = slack.getBotUserId();

        // Bot joined channel → trigger backfill
        if (botUserId && isBotJoinEvent(event, botUserId)) {
          const [existingChannel, metadata] = await Promise.all([
            db.getChannel(workspaceId, event.channel),
            resolveChannelMetadata(workspaceId, event.channel),
          ]);
          if (!metadata && !existingChannel) {
            log.warn(
              { workspaceId, channelId: event.channel },
              "Skipping channel creation after bot join because Slack metadata is unavailable",
            );
            await finishProcessed();
            return;
          }
          await db.upsertChannel(
            workspaceId,
            event.channel,
            "pending",
            metadata?.name ?? existingChannel?.name ?? null,
            metadata?.conversationType ??
              existingChannel?.conversation_type ??
              "public_channel",
          );
          eventBus.createAndPublish(
            "channel_status_changed",
            workspaceId,
            event.channel,
            {
              newStatus: "pending",
            },
          );
          await enqueueBackfill(
            workspaceId,
            event.channel,
            "member_joined_channel",
          );
          await finishProcessed();
          return;
        }

        // Bot removed from channel or channel access revoked → remove local state immediately
        if (botUserId && isBotLeaveEvent(event, botUserId)) {
          await db.deleteChannelCascade(workspaceId, event.channel);
          eventBus.createAndPublish(
            "channel_status_changed",
            workspaceId,
            event.channel,
            {
              newStatus: "removed",
              removedAt: new Date().toISOString(),
            },
          );
          log.info(
            { channel: event.channel },
            "Removed channel after bot left channel",
          );
          await finishProcessed();
          return;
        }

        // Human message → enqueue for processing
        if (isCandidateMessageEvent(event)) {
          const messageChannelId = event.channel;
          const messageTs = event.ts;
          const messageBotId = event.bot_id ?? null;

          // Ensure channel exists in DB
          let channel = await db.getChannel(workspaceId, messageChannelId);
          if (!channel) {
            const metadata = await resolveChannelMetadata(
              workspaceId,
              messageChannelId,
            );
            if (!metadata) {
              log.warn(
                {
                  workspaceId,
                  channelId: messageChannelId,
                  eventTs: messageTs,
                },
                "Skipping channel creation for message because Slack metadata is unavailable",
              );
              await finishProcessed();
              return;
            }
            channel = await db.upsertChannel(
              workspaceId,
              messageChannelId,
              "pending",
              metadata.name,
              metadata.conversationType,
            );
          } else if (!channel.name) {
            const metadata = await resolveChannelMetadata(
              workspaceId,
              messageChannelId,
            );
            if (metadata) {
              channel = await db.upsertChannel(
                workspaceId,
                messageChannelId,
                channel.status,
                metadata.name ?? channel.name,
                metadata.conversationType,
              );
            }
          }

          const allowAutomatedMessages = allowsAutomatedMessageIngestion(
            channel?.name,
          );
          if (!isProcessableMessageEvent(event, { allowAutomatedMessages })) {
            log.debug(
              {
                workspaceId,
                channelId: messageChannelId,
                eventTs: messageTs,
                allowAutomatedMessages,
                botId: messageBotId,
              },
              "Skipping unsupported Slack message event for this channel",
            );
            await finishProcessed();
            return;
          }

          // Recovery path: if a channel is not ready because setup stalled or failed,
          // re-queue backfill so live activity can recover the channel automatically.
          if (channel?.status === "pending" || channel?.status === "failed") {
            const recoveryReason =
              channel.status === "failed"
                ? "failed_message_recovery"
                : "pending_message_recovery";
            await db.updateChannelStatus(
              workspaceId,
              messageChannelId,
              "pending",
            );
            eventBus.createAndPublish(
              "channel_status_changed",
              workspaceId,
              messageChannelId,
              {
                newStatus: "pending",
              },
            );
            await enqueueBackfill(
              workspaceId,
              messageChannelId,
              recoveryReason,
            );
          }

          // Extract file metadata if present
          const msgEvent =
            event as import("../types/slack.js").SlackMessageEvent;
          const files = msgEvent.files?.map((f) => ({
            name: f.name,
            title: f.title,
            mimetype: f.mimetype,
            filetype: f.filetype,
            size: f.size,
            permalink: f.permalink,
          }));

          await enqueueMessageIngest({
            workspaceId,
            channelId: messageChannelId,
            ts: messageTs,
            userId: event.user,
            text: event.text ?? "",
            threadTs: event.thread_ts ?? null,
            eventId: callbackPayload.event_id ?? messageTs,
            ...(event.subtype ? { subtype: event.subtype } : {}),
            ...(messageBotId ? { botId: messageBotId } : {}),
            files: files && files.length > 0 ? files : undefined,
          });

          log.info(
            {
              channel: messageChannelId,
              user: event.user,
              ts: messageTs,
              thread_ts: event.thread_ts ?? null,
              channelStatus: channel?.status ?? "new",
            },
            "Message received",
          );
        }

        if (isMessageChangedEvent(event)) {
          const channel = await db.getChannel(workspaceId, event.channel);
          if (!channel) {
            log.debug(
              { workspaceId, channelId: event.channel, ts: event.message.ts },
              "Skipping message edit because channel is not tracked locally",
            );
            await finishProcessed();
            return;
          }

          const files =
            event.message.files?.map((f) => ({
              name: f.name,
              title: f.title,
              mimetype: f.mimetype,
              filetype: f.filetype,
              size: f.size,
              permalink: f.permalink,
            })) ?? null;
          const extractedLinks = extractLinks(event.message.text ?? "");
          const updatedMessage =
            (await db.replaceMessageContent({
              workspaceId,
              channelId: event.channel,
              ts: event.message.ts,
              userId: event.message.user,
              text: event.message.text ?? "",
              threadTs: event.message.thread_ts ?? null,
              subtype: event.message.subtype ?? null,
              botId: event.message.bot_id ?? null,
              filesJson: files,
              linksJson: extractedLinks.length > 0 ? extractedLinks : null,
            })) ??
            (await db.upsertMessage(
              workspaceId,
              event.channel,
              event.message.ts,
              event.message.user,
              event.message.text ?? "",
              "realtime",
              event.message.thread_ts ?? null,
              event.message.subtype ?? null,
              event.message.bot_id ?? null,
              files,
              extractedLinks.length > 0 ? extractedLinks : null,
            ));

          const normalizedText = (
            normalizeText(event.message.text ?? "") +
            buildFileContext(files) +
            buildLinkContext(extractedLinks.length > 0 ? extractedLinks : null)
          ).trim();
          await db.updateNormalizedText(
            workspaceId,
            event.channel,
            event.message.ts,
            normalizedText,
          );
          await db.deleteMessageAnalytics(
            workspaceId,
            event.channel,
            event.message.ts,
          );

          if (channel.status === "ready") {
            await reconcileFollowUpSourceEdit({
              workspaceId,
              channelId: event.channel,
              ts: event.message.ts,
              threadTs: updatedMessage.thread_ts,
              userId: event.message.user,
              text: normalizedText,
              rawText: event.message.text ?? "",
            });
            await enqueueLLMAnalyze({
              workspaceId,
              channelId: event.channel,
              triggerType: "manual",
              mode: "visible_messages",
              threadTs: updatedMessage.thread_ts,
              targetMessageTs: [event.message.ts],
            });
          }

          eventBus.createAndPublish(
            "message_ingested",
            workspaceId,
            event.channel,
            {
              ts: event.message.ts,
              userId: event.message.user,
              threadTs: updatedMessage.thread_ts,
              analysisStatus: "pending",
              edited: true,
            },
          );
          await finishProcessed();
          return;
        }

        if (isMessageDeletedEvent(event)) {
          const channel = await db.getChannel(workspaceId, event.channel);
          if (!channel) {
            await finishProcessed();
            return;
          }

          await db.markMessageDeleted(
            workspaceId,
            event.channel,
            event.deleted_ts,
          );
          await db.deleteMessageAnalytics(
            workspaceId,
            event.channel,
            event.deleted_ts,
          );

          const [sourceItem, responderItems, resolvedItems] = await Promise.all(
            [
              db.getOpenFollowUpBySourceMessage(
                workspaceId,
                event.channel,
                event.deleted_ts,
              ),
              db.listOpenFollowUpsByResponderMessage(
                workspaceId,
                event.channel,
                event.deleted_ts,
              ),
              db.listResolvedFollowUpsByResolvedMessage(
                workspaceId,
                event.channel,
                event.deleted_ts,
              ),
            ],
          );

          if (sourceItem) {
            await clearFollowUpReminderDms(workspaceId, sourceItem.id);
            await db.dismissFollowUpItem(
              sourceItem.id,
              event.previous_message?.user ?? null,
            );
            await db.recordFollowUpEvent({
              followUpItemId: sourceItem.id,
              workspaceId,
              channelId: event.channel,
              eventType: "dismissed",
              workflowState: "dismissed",
              actorUserId: event.previous_message?.user ?? null,
              messageTs: event.deleted_ts,
              metadata: {
                reason: "source_message_deleted",
              },
            });
            emitFollowUpAlert({
              workspaceId,
              channelId: event.channel,
              followUpItemId: sourceItem.id,
              alertType: "follow_up_dismissed",
              changeType: "dismissed",
              seriousness: sourceItem.seriousness,
              sourceMessageTs: sourceItem.source_message_ts,
              threadTs: sourceItem.source_thread_ts,
              summary:
                "The source message was deleted, so this follow-up was removed.",
            });
          }

          for (const item of responderItems) {
            await reopenFollowUpAfterEvidenceRemoval({
              workspaceId,
              channelId: event.channel,
              item,
              actorUserId: event.previous_message?.user ?? null,
              messageTs: event.deleted_ts,
              reason: "responder_message_deleted",
              summary:
                "A responder message was deleted, so this follow-up needs attention again.",
            });
          }

          for (const item of resolvedItems) {
            await reopenFollowUpAfterEvidenceRemoval({
              workspaceId,
              channelId: event.channel,
              item,
              actorUserId: event.previous_message?.user ?? null,
              messageTs: event.deleted_ts,
              reason: "responder_message_deleted",
              summary:
                "The resolving reply was deleted, so this follow-up has been reopened.",
            });
          }

          eventBus.createAndPublish(
            "message_ingested",
            workspaceId,
            event.channel,
            {
              ts: event.deleted_ts,
              userId: event.previous_message?.user ?? null,
              threadTs: event.previous_message?.thread_ts ?? null,
              analysisStatus: "skipped",
              deleted: true,
            },
          );
          await finishProcessed();
          return;
        }

        // Reaction added → resolve follow-ups if it's an acknowledgment reaction
        if (isReactionAddedEvent(event)) {
          const ackReactions = new Set(
            config.FOLLOW_UP_ACK_REACTIONS.split(",").map((r) => r.trim()),
          );

          if (ackReactions.has(event.reaction)) {
            const openItems = await db.listOpenFollowUpsBySourceMessage(
              workspaceId,
              event.item.channel,
              event.item.ts,
            );

            let resolvedCount = 0;
            for (const item of openItems) {
              const ackAt = new Date(
                Number.parseFloat(event.event_ts ?? event.item.ts) * 1000,
              );
              const ackExtensionHours = Math.min(
                config.FOLLOW_UP_ACK_EXTENSION_HOURS,
                config.FOLLOW_UP_DEFAULT_SLA_HOURS,
              );
              const dueAt = new Date(
                ackAt.getTime() + ackExtensionHours * 60 * 60 * 1000,
              );

              await clearFollowUpReminderDms(workspaceId, item.id);
              await db.acknowledgeFollowUpItem({
                itemId: item.id,
                dueAt,
                acknowledgedAt: ackAt,
                acknowledgedByUserId: event.user,
                acknowledgmentSource: "reaction",
                responderMessageTs: event.item.ts,
              });
              await db.recordFollowUpEvent({
                followUpItemId: item.id,
                workspaceId,
                channelId: event.item.channel,
                eventType: "acknowledged",
                workflowState: "acknowledged_waiting",
                actorUserId: event.user,
                messageTs: event.item.ts,
                metadata: {
                  reaction: event.reaction,
                  dueAt: dueAt.toISOString(),
                },
              });
              emitFollowUpAlert({
                workspaceId,
                channelId: event.item.channel,
                followUpItemId: item.id,
                alertType: "follow_up_acknowledged",
                changeType: "acknowledged",
                seriousness: item.seriousness,
                sourceMessageTs: item.source_message_ts,
                threadTs: item.source_thread_ts,
                summary: `Soft acknowledgment via :${event.reaction}: reaction`,
              });
              resolvedCount++;
            }

            if (resolvedCount > 0) {
              log.info(
                {
                  channelId: event.item.channel,
                  reaction: event.reaction,
                  messageTs: event.item.ts,
                  resolvedCount,
                },
                "Follow-ups acknowledged via reaction",
              );
            }
          }
        }

        if (isReactionRemovedEvent(event)) {
          const ackReactions = new Set(
            config.FOLLOW_UP_ACK_REACTIONS.split(",").map((r) => r.trim()),
          );

          if (ackReactions.has(event.reaction)) {
            const openItems = await db.listOpenFollowUpsBySourceMessage(
              workspaceId,
              event.item.channel,
              event.item.ts,
            );

            for (const item of openItems) {
              if (
                item.workflow_state !== "acknowledged_waiting" ||
                item.acknowledgment_source !== "reaction"
              ) {
                continue;
              }

              await reopenFollowUpAfterEvidenceRemoval({
                workspaceId,
                channelId: event.item.channel,
                item,
                actorUserId: event.user,
                messageTs: event.item.ts,
                reason: "reaction_removed",
                summary: `The :${event.reaction}: acknowledgment was removed, so this follow-up needs a reply again.`,
              });
            }
          }
        }

        await finishProcessed();
      } catch (err) {
        try {
          await db.failSlackEvent(
            workspaceId,
            eventId,
            err instanceof Error ? err.message : String(err),
          );
        } catch (markError) {
          log.error(
            { err: markError, workspaceId, eventId },
            "Failed to mark Slack event as failed",
          );
        }
        log.error(
          { err, workspaceId, eventType: event.type },
          "Error processing Slack event before acknowledgment",
        );
        res.status(503).json({
          error: "slack_event_processing_failed",
          requestId: req.id,
        });
      }

      return;
    }

    res.sendStatus(200);
  },
);
