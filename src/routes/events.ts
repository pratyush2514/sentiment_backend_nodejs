import { Router } from "express";
import { config } from "../config.js";
import { eventBus } from "../services/eventBus.js";
import { logger } from "../utils/logger.js";
import type { DashboardEvent } from "../types/database.js";
import type { Request, Response } from "express";

const log = logger.child({ route: "events" });

export const eventsRouter = Router();

/**
 * GET /api/events/stream
 * Server-Sent Events endpoint for real-time dashboard updates.
 * Filters events by workspace (from auth) and optional channel_id query param.
 */
eventsRouter.get("/stream", (req: Request, res: Response) => {
  const workspaceId = req.workspaceId ?? "default";
  const channelId = req.query.channel_id as string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    eventBus.off("dashboard_event", onEvent);
    log.debug({ workspaceId, channelId }, "SSE client disconnected");
  };

  const onEvent = (event: DashboardEvent) => {
    if (cleaned || res.destroyed) { cleanup(); return; }
    if (event.workspaceId !== workspaceId) return;
    if (channelId && event.channelId !== channelId) return;
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
    }
  };

  eventBus.on("dashboard_event", onEvent);

  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ workspaceId, channelId: channelId ?? null })}\n\n`);
  } catch {
    cleanup();
    return;
  }

  heartbeat = setInterval(() => {
    if (res.destroyed) { cleanup(); return; }
    try {
      res.write(": heartbeat\n\n");
    } catch {
      cleanup();
    }
  }, config.SSE_HEARTBEAT_MS);

  req.on("close", cleanup);
  req.on("error", cleanup);
});
