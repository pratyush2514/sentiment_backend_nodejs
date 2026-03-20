import { Router } from "express";
import { config } from "../config.js";
import { checkConnection, checkDirectConnection, getMigrationStatus } from "../db/pool.js";
import { getQueueRuntimeState } from "../queue/boss.js";
import { getRuntimeState } from "../services/runtimeState.js";

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
  const directDbOk = await Promise.race([
    checkDirectConnection(),
    new Promise<boolean>((_, reject) =>
      setTimeout(
        () => reject(new Error("Direct DB health check timeout")),
        config.HEALTHCHECK_DB_TIMEOUT_MS,
      ),
    ),
  ]).catch(() => false);

  const migrationStatus = await Promise.race([
    getMigrationStatus(),
    new Promise<Awaited<ReturnType<typeof getMigrationStatus>>>((_, reject) =>
      setTimeout(
        () => reject(new Error("Migration health check timeout")),
        config.HEALTHCHECK_MIGRATION_TIMEOUT_MS,
      ),
    ),
  ]).catch(() => ({
    applied: [],
    pending: ["migration_status_unavailable"],
    upToDate: false,
  }));

  const queueState = getQueueRuntimeState();
  const runtimeState = getRuntimeState();
  const queueOk = queueState.started;
  const migrationsOk = migrationStatus.upToDate;
  const workersOk =
    runtimeState.role === "worker" || runtimeState.role === "all"
      ? queueState.workersRegistered
      : true;
  const schedulerOk =
    runtimeState.role === "scheduler" || runtimeState.role === "all"
      ? runtimeState.schedulerRunning
      : true;
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const allOk = dbOk && directDbOk && queueOk && migrationsOk && workersOk && schedulerOk;

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    uptime: uptimeSeconds,
    role: runtimeState.role,
    checks: {
      database: dbOk ? "connected" : "disconnected",
      directDatabase: directDbOk ? "connected" : "disconnected",
      queue: queueOk ? "running" : "not_started",
      migrations: migrationsOk ? "up_to_date" : "pending",
      workers: workersOk
        ? runtimeState.role === "worker" || runtimeState.role === "all"
          ? "registered"
          : "not_applicable"
        : "not_registered",
      scheduler: schedulerOk
        ? runtimeState.role === "scheduler" || runtimeState.role === "all"
          ? "running"
          : "not_applicable"
        : "not_running",
    },
    details: {
      pendingMigrations: migrationStatus.pending,
      runtime: runtimeState,
    },
  });
});

// Backward compatibility: redirect root to readiness
healthRouter.get("/", (_req, res) => {
  res.redirect(301, "/health/ready");
});
