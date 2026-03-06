import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { runMigrations, checkConnection, shutdown as shutdownDb } from "./db/pool.js";
import { getStuckInitializingChannels } from "./db/queries.js";
import { requireApiAuth } from "./middleware/apiAuth.js";
import { startQueue, stopQueue, enqueueBackfill } from "./queue/boss.js";
import { analyticsRouter } from "./routes/analytics.js";
import { channelsRouter } from "./routes/channels.js";
import { healthRouter } from "./routes/health.js";
import { slackEventsRouter } from "./routes/slackEvents.js";
import { resolveBotUserId } from "./services/slackClient.js";
import { startReconcileLoop, stopReconcileLoop } from "./services/threadReconcile.js";
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

// Request timeout
app.use((req: Request, res: Response, next: NextFunction) => {
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
app.use("/api/channels", requireApiAuth, channelsRouter);
app.use("/api/analytics", requireApiAuth, analyticsRouter);
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

async function start(): Promise<void> {
  logger.info("Starting Slack Sentiment Analysis System...");

  // 1. Check database connection
  const dbOk = await checkConnection();
  if (!dbOk) {
    logger.fatal("Cannot connect to database. Exiting.");
    process.exit(1);
  }
  logger.info("Database connected");

  // 2. Run migrations
  await runMigrations();
  logger.info("Migrations complete");

  // 3. Start pg-boss queue
  await startQueue();
  logger.info("Queue started");

  // 4. Resolve bot user ID
  if (config.SLACK_BOT_TOKEN) {
    const botId = await resolveBotUserId();
    logger.info({ botUserId: botId }, "Bot identity resolved");
  } else {
    logger.warn("SLACK_BOT_TOKEN not set — backfill and event processing disabled");
  }

  // 5. Recover channels stuck in 'initializing' (crash recovery)
  const stuckChannels = await getStuckInitializingChannels();
  for (const ch of stuckChannels) {
    await enqueueBackfill(ch.workspace_id, ch.channel_id, "startup-recovery");
    logger.info({ channelId: ch.channel_id }, "Re-enqueued backfill for stuck channel");
  }
  if (stuckChannels.length > 0) {
    logger.info({ count: stuckChannels.length }, "Startup recovery: re-enqueued stuck channels");
  }

  // 6. Start thread reconciliation loop
  startReconcileLoop();
  logger.info("Thread reconciliation loop started");

  // 7. Start HTTP server
  server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Server listening");
  });
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
      logger.info("HTTP server closed");
    });
  }

  // 2. Stop reconcile loop
  stopReconcileLoop();

  // 3. Drain queue
  await stopQueue();

  // 4. Close DB pools
  await shutdownDb();

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
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
