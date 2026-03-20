import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";

export const analyticsRouter = Router();

const log = logger.child({ route: "analytics" });

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const trendsQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
  channel_id: z.string().regex(/^[A-Z0-9]{1,20}$/i, "Invalid channel ID format").optional(),
  granularity: z.enum(["hourly", "daily"]).optional().default("daily"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const costsQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const overviewQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

analyticsRouter.get("/sentiment-trends", async (req, res) => {
  const query = trendsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const buckets = await db.getSentimentTrends(workspaceId, {
    channelId: query.data.channel_id ?? null,
    granularity: query.data.granularity,
    from: query.data.from ?? null,
    to: query.data.to ?? null,
    limit: query.data.limit,
  });

  log.debug({ workspaceId, buckets: buckets.length }, "Sentiment trends fetched");

  res.status(200).json({
    granularity: query.data.granularity,
    filters: {
      channelId: query.data.channel_id ?? null,
      from: query.data.from ?? null,
      to: query.data.to ?? null,
    },
    total: buckets.length,
    buckets,
  });
});

analyticsRouter.get("/costs", async (req, res) => {
  const query = costsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const breakdown = await db.getCostBreakdown(workspaceId, {
    from: query.data.from ?? null,
    to: query.data.to ?? null,
    limit: query.data.limit,
  });

  const totalCostUsd = breakdown.reduce((sum, row) => sum + row.totalCostUsd, 0);

  log.debug({ workspaceId, rows: breakdown.length, totalCostUsd }, "Cost breakdown fetched");

  res.status(200).json({
    filters: {
      from: query.data.from ?? null,
      to: query.data.to ?? null,
    },
    total: breakdown.length,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    breakdown,
  });
});

analyticsRouter.get("/overview", async (req, res) => {
  const query = overviewQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const overview = await db.getAnalyticsOverview(workspaceId);

  log.debug({ workspaceId }, "Analytics overview fetched");

  res.status(200).json(overview);
});
