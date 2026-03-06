import express, { Router } from "express";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { getRawBody, verifySlackSignature } from "../middleware/slackSignature.js";
import { enqueueBackfill, enqueueMessageIngest } from "../queue/boss.js";
import { getBotUserId } from "../services/slackClient.js";
import {
  isProcessableHumanMessageEvent,
  isBotJoinEvent,
} from "../types/slack.js";
import { logger } from "../utils/logger.js";
import type {
  SlackPayload,
  SlackUrlVerificationPayload,
  SlackEventCallbackPayload,
} from "../types/slack.js";

export const slackEventsRouter = Router();

const log = logger.child({ route: "slackEvents" });

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
      const workspaceId = callbackPayload.team_id ?? DEFAULT_WORKSPACE;

      // Deduplicate events via database
      if (typeof callbackPayload.event_id === "string") {
        const isNew = await db.markEventSeen(
          workspaceId,
          callbackPayload.event_id,
          callbackPayload.event.type,
        );
        if (!isNew) {
          res.sendStatus(200);
          return;
        }
      }

      const event = callbackPayload.event;
      const botUserId = getBotUserId();

      // Bot joined channel → trigger backfill
      if (botUserId && isBotJoinEvent(event, botUserId)) {
        await db.upsertChannel(workspaceId, event.channel);
        await enqueueBackfill(workspaceId, event.channel, "member_joined_channel");
        res.sendStatus(200);
        return;
      }

      // Human message → enqueue for processing
      if (isProcessableHumanMessageEvent(event)) {
        // Ensure channel exists in DB
        const channel = await db.getChannel(workspaceId, event.channel);
        if (!channel) {
          await db.upsertChannel(workspaceId, event.channel);
        }

        // Check channel status — if initializing, the backfill handler
        // will pick up messages via DB anyway. For ready channels, enqueue ingest.
        if (!channel || channel.status === "ready") {
          await enqueueMessageIngest({
            workspaceId,
            channelId: event.channel,
            ts: event.ts,
            userId: event.user,
            text: event.text,
            threadTs: event.thread_ts ?? null,
            eventId: callbackPayload.event_id ?? event.ts,
          });
        } else if (channel.status === "initializing") {
          // Store directly — backfill will handle dedup via UPSERT
          await db.upsertMessage(
            workspaceId,
            event.channel,
            event.ts,
            event.user,
            event.text,
            "realtime",
            event.thread_ts,
          );
        }

        log.info({
          channel: event.channel,
          user: event.user,
          ts: event.ts,
          thread_ts: event.thread_ts ?? null,
          channelStatus: channel?.status ?? "new",
        }, "Message received");
      }

      res.sendStatus(200);
      return;
    }

    res.sendStatus(200);
  },
);
