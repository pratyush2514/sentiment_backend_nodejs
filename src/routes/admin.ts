import { Router } from "express";
import { pool } from "../db/pool.js";
import { purgeAllJobs } from "../queue/boss.js";
import { eventBus } from "../services/eventBus.js";
import { logger } from "../utils/logger.js";
import type { Request, Response } from "express";

const log = logger.child({ route: "admin" });

export const adminRouter = Router();

/**
 * GET /api/admin/health
 * Returns queue depths, SSE connection count, and server timestamp.
 * Protected by requireApiAuth (applied at mount point in index.ts).
 */
adminRouter.get("/health", async (_req: Request, res: Response) => {
  try {
    // Query pg-boss tables for queue depths (created + failed)
    const [createdResult, failedResult] = await Promise.all([
      pool.query<{ name: string; depth: string }>(
        `SELECT name, count(*) AS depth FROM pgboss.job WHERE state = 'created' GROUP BY name`,
      ),
      pool.query<{ name: string; failed: string }>(
        `SELECT name, count(*) AS failed FROM pgboss.job WHERE state = 'failed' GROUP BY name`,
      ),
    ]);

    // Build queues object keyed by queue name
    const queues: Record<string, { depth: number; failed: number }> = {};

    for (const row of createdResult.rows) {
      queues[row.name] = { depth: Number(row.depth), failed: 0 };
    }

    for (const row of failedResult.rows) {
      if (queues[row.name]) {
        queues[row.name].failed = Number(row.failed);
      } else {
        queues[row.name] = { depth: 0, failed: Number(row.failed) };
      }
    }

    // SSE connection count via EventEmitter listenerCount
    const sseConnections = eventBus.listenerCount("dashboard_event");

    res.json({
      queues,
      sse: { connections: sseConnections },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error({ err }, "Admin health check failed");
    res.status(500).json({
      error: "health_check_failed",
      message: err instanceof Error ? err.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * POST /api/admin/purge-queue
 * Purges all pending jobs from every pg-boss queue.
 * Useful for development/testing after wiping the DB.
 */
adminRouter.post("/purge-queue", async (_req: Request, res: Response) => {
  try {
    const purged = await purgeAllJobs();
    log.info({ purged }, "Queue purged via admin endpoint");
    res.json({ ok: true, purged, timestamp: new Date().toISOString() });
  } catch (err) {
    log.error({ err }, "Failed to purge queue");
    res.status(500).json({
      error: "purge_failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
