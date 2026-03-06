import { Router } from "express";
import { config } from "../config.js";
import { checkConnection } from "../db/pool.js";
import { getQueue } from "../queue/boss.js";

export const healthRouter = Router();

const startedAt = Date.now();

// Liveness: process is up
healthRouter.get("/health/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Readiness: dependencies are reachable
healthRouter.get("/health/ready", async (_req, res) => {
  const dbOk = await Promise.race([
    checkConnection(),
    new Promise<boolean>((_, reject) =>
      setTimeout(() => reject(new Error("DB health check timeout")), config.HEALTHCHECK_DB_TIMEOUT_MS),
    ),
  ]).catch(() => false);

  const queueOk = getQueue() !== null;
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const allOk = dbOk && queueOk;

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    uptime: uptimeSeconds,
    checks: {
      database: dbOk ? "connected" : "disconnected",
      queue: queueOk ? "running" : "not_started",
    },
  });
});

// Backward compatibility: redirect root to readiness
healthRouter.get("/", (_req, res) => {
  res.redirect(301, "/health/ready");
});
