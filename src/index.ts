import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import {
  runMigrations,
  checkConnection,
  checkDirectConnection,
  getMigrationStatus,
  shutdown as shutdownDb,
} from "./db/pool.js";
import { getStuckInitializingChannels } from "./db/queries.js";
import { requireApiAuth } from "./middleware/apiAuth.js";
import { startQueue, stopQueue, enqueueBackfill } from "./queue/boss.js";
import { adminRouter } from "./routes/admin.js";
import { alertsRouter } from "./routes/alerts.js";
import { analyticsRouter } from "./routes/analytics.js";
import { authRouter } from "./routes/auth.js";
import { channelsRouter } from "./routes/channels.js";
import { conversationPoliciesRouter } from "./routes/conversationPolicies.js";
import { eventsRouter } from "./routes/events.js";
import { followUpRulesRouter } from "./routes/followUpRules.js";
import { healthRouter } from "./routes/health.js";
import { inboxRouter } from "./routes/inbox.js";
import { rolesRouter } from "./routes/roles.js";
import { slackRouter } from "./routes/slack.js";
import { slackEventsRouter } from "./routes/slackEvents.js";
import { startChannelMemberSync, stopChannelMemberSync } from "./services/channelMemberSync.js";
import { startFollowUpSweep, stopFollowUpSweep } from "./services/followUpSweep.js";
import { startQueueMaintenance, stopQueueMaintenance } from "./services/queueMaintenance.js";
import { startRetentionSchedule, stopRetentionSchedule } from "./services/retentionSweep.js";
import {
  markHttpServing,
  markQueueRuntimeState,
  markSchedulerRunning,
} from "./services/runtimeState.js";
import { resolveBotUserId } from "./services/slackClient.js";
import { startReconcileLoop, stopReconcileLoop } from "./services/threadReconcile.js";
import { startTokenRotationSchedule, stopTokenRotationSchedule } from "./services/tokenRotationSchedule.js";
import { logger } from "./utils/logger.js";
import type { Request, Response, NextFunction } from "express";


const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({ origin: config.CORS_ORIGIN }));

// Trust proxy (when behind reverse proxy / load balancer)
if (config.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

// Request ID middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.id = (req.get("X-Request-ID") as string | undefined) ?? crypto.randomUUID();
  next();
});

// Request timeout (exempt SSE stream from timeout)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/events")) {
    next();
    return;
  }
  res.setTimeout(config.REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: "request_timeout", requestId: req.id });
    }
  });
  next();
});

// JSON parsing for API routes with body size limit (slack events use raw body, handled in slackEventsRouter)
app.use("/api", express.json({ limit: "1mb" }));

// Routes
app.use("/", healthRouter);
app.use("/api/auth", express.json({ limit: "1mb" }), authRouter);
app.use("/api/admin", requireApiAuth, adminRouter);
app.use("/api/channels", requireApiAuth, channelsRouter);
app.use("/api/analytics", requireApiAuth, analyticsRouter);
app.use("/api/alerts", requireApiAuth, alertsRouter);
app.use("/api/inbox", requireApiAuth, inboxRouter);
app.use("/api/follow-up-rules", requireApiAuth, followUpRulesRouter);
app.use("/api/conversation-policies", requireApiAuth, conversationPoliciesRouter);
app.use("/api/roles", requireApiAuth, rolesRouter);
app.use("/api/events", requireApiAuth, eventsRouter);
app.use("/api/slack", requireApiAuth, slackRouter);
app.use("/slack/events", slackEventsRouter);

// Centralized error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = req.id ?? "unknown";
  logger.error({ err, requestId, path: req.path }, "Unhandled error");

  if (!res.headersSent) {
    res.status(500).json({
      error: "internal_server_error",
      message: config.NODE_ENV !== "production" ? err.message : "An unexpected error occurred",
      requestId,
    });
  }
});

let server: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;

function roleIncludesWeb(): boolean {
  return config.RUNTIME_ROLE === "all" || config.RUNTIME_ROLE === "web";
}

function roleIncludesWorkers(): boolean {
  return config.RUNTIME_ROLE === "all" || config.RUNTIME_ROLE === "worker";
}

function roleIncludesScheduler(): boolean {
  return config.RUNTIME_ROLE === "all" || config.RUNTIME_ROLE === "scheduler";
}

async function start(): Promise<void> {
  logger.info("Starting Slack Sentiment Analysis System...");
  logger.info({ runtimeRole: config.RUNTIME_ROLE }, "Runtime role selected");
  logger.info(
    {
      llmProvider: config.LLM_PROVIDER,
      llmModel: config.LLM_MODEL,
      llmThreadModel: config.LLM_MODEL_THREAD,
      embeddingsEnabled: Boolean(config.OPENAI_API_KEY),
    },
    "LLM configuration",
  );

  // 1. Check database connection
  const dbOk = await checkConnection();
  const directDbOk = await checkDirectConnection();
  if (!dbOk || !directDbOk) {
    logger.fatal(
      { pooledConnectionOk: dbOk, directConnectionOk: directDbOk },
      "Cannot connect to required database endpoints. Exiting.",
    );
    process.exit(1);
  }
  logger.info("Database connections verified");

  // 2. Run or verify migrations
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    await runMigrations();
    logger.info("Migrations complete");
  } else {
    const migrationStatus = await getMigrationStatus();
    if (!migrationStatus.upToDate) {
      logger.fatal(
        { pendingMigrations: migrationStatus.pending },
        "Pending migrations detected and RUN_MIGRATIONS_ON_BOOT is disabled",
      );
      process.exit(1);
    }
    logger.info("Migration status verified");
  }

  // 3. Start pg-boss queue
  await startQueue({ registerWorkers: roleIncludesWorkers() });
  markQueueRuntimeState({
    queueStarted: true,
    workersRegistered: roleIncludesWorkers(),
  });
  logger.info("Queue started");

  // 4. Resolve bot user ID
  if (config.SLACK_BOT_TOKEN) {
    const botId = await resolveBotUserId();
    logger.info({ botUserId: botId }, "Bot identity resolved");
  } else {
    logger.info("SLACK_BOT_TOKEN not set — bot tokens will be resolved per-workspace from the database");
  }

  if (roleIncludesScheduler()) {
    const stuckChannels = await getStuckInitializingChannels();
    for (const ch of stuckChannels) {
      await enqueueBackfill(ch.workspace_id, ch.channel_id, "startup-recovery");
      logger.info({ channelId: ch.channel_id }, "Re-enqueued backfill for stuck channel");
    }
    if (stuckChannels.length > 0) {
      logger.info({ count: stuckChannels.length }, "Startup recovery: re-enqueued stuck channels");
    }

    startReconcileLoop();
    logger.info("Thread reconciliation loop started");

    startQueueMaintenance();
    logger.info("Queue maintenance loop started");

    startFollowUpSweep();
    logger.info("Follow-up reminder sweep started");

    startRetentionSchedule();
    logger.info("Data retention sweep scheduled");

    startChannelMemberSync();
    logger.info("Channel member sync scheduled");

    startTokenRotationSchedule();
    logger.info("Slack bot token refresh sweep scheduled");
    markSchedulerRunning(true);
  }

  if (roleIncludesWeb()) {
    server = app.listen(config.PORT, () => {
      markHttpServing(true);
      logger.info({ port: config.PORT }, "Server listening");
    });
  } else {
    logger.info("HTTP server disabled for this runtime role");
  }
}

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received");

  // Force exit after timeout
  const forceTimer = setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  // 1. Stop accepting new connections
  if (server) {
    server.close(() => {
      markHttpServing(false);
      logger.info("HTTP server closed");
    });
  }

  if (roleIncludesScheduler()) {
    stopReconcileLoop();
    stopQueueMaintenance();
    stopFollowUpSweep();
    stopRetentionSchedule();
    stopChannelMemberSync();
    stopTokenRotationSchedule();
    markSchedulerRunning(false);
  }

  // 3. Drain queue
  await stopQueue();

  // 4. Close DB pools
  await shutdownDb();

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Transient network errors (ETIMEDOUT, ECONNRESET, EPIPE) from idle DB
// connections should NOT crash the process. The pool replaces dead connections
// automatically on the next query.
const RECOVERABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "ECONNREFUSED"]);

process.on("uncaughtException", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code && RECOVERABLE_CODES.has(code)) {
    logger.warn({ err: err.message, code }, "Recoverable connection error (not crashing)");
    return;
  }
  logger.fatal({ err }, "Uncaught exception — shutting down");
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled rejection — shutting down");
  gracefulShutdown("unhandledRejection");
});

start().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
