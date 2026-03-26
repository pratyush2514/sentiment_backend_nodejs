import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import * as db from "../db/queries.js";
import { getRawBody } from "../middleware/slackSignature.js";
import {
  enqueueMeetingHistoricalSync,
  enqueueMeetingIngest,
} from "../queue/boss.js";
import {
  registerFathomWebhook,
  validateFathomApiKey,
} from "../services/fathomClient.js";
import {
  isHistoricalSyncLeaseStale,
  recoverHistoricalSyncLease,
} from "../services/fathomHistoricalSyncRecovery.js";
import {
  getFathomWebhookSecret,
  revokeFathomConnection,
  storeFathomApiKey,
} from "../services/fathomTokenManager.js";
import { logger } from "../utils/logger.js";
import type { FathomConnectionRow } from "../types/database.js";
import type { Request, Response } from "express";

const log = logger.child({ service: "fathom-routes" });
const HISTORICAL_SYNC_WINDOW_DAYS = 14;

export const fathomRouter = Router();
export const fathomWebhookRouter = Router();

function sendFathomError(
  res: Response,
  status: number,
  error: string,
  message: string,
): void {
  res.status(status).json({ error, message });
}

function readRequestedWorkspaceId(req: Request): string | null {
  const queryWorkspaceId = req.query.workspace_id;
  if (typeof queryWorkspaceId === "string" && queryWorkspaceId.length > 0) {
    return queryWorkspaceId;
  }

  if (req.body && typeof req.body === "object") {
    if (
      "workspace_id" in req.body &&
      typeof req.body.workspace_id === "string" &&
      req.body.workspace_id.length > 0
    ) {
      return req.body.workspace_id;
    }
    if (
      "workspaceId" in req.body &&
      typeof req.body.workspaceId === "string" &&
      req.body.workspaceId.length > 0
    ) {
      return req.body.workspaceId;
    }
  }

  return null;
}

function resolveWorkspaceId(req: Request, res: Response): string | null {
  const requestedWorkspaceId = readRequestedWorkspaceId(req);
  const authenticatedWorkspaceId = req.workspaceId ?? null;

  if (
    authenticatedWorkspaceId &&
    requestedWorkspaceId &&
    requestedWorkspaceId !== authenticatedWorkspaceId
  ) {
    sendFathomError(
      res,
      403,
      "workspace_mismatch",
      "Your session is out of sync with the selected workspace. Refresh and try again.",
    );
    return null;
  }

  const workspaceId = authenticatedWorkspaceId ?? requestedWorkspaceId;
  if (!workspaceId) {
    sendFathomError(
      res,
      400,
      "workspace_id_required",
      "A workspace id is required for this Fathom request.",
    );
    return null;
  }

  return workspaceId;
}

function getWebhookUrl(workspaceId: string): string | null {
  const baseUrl = config.PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/api/fathom/webhook/${workspaceId}`;
}

function buildHistoricalSyncPayload(conn: FathomConnectionRow) {
  return {
    status: conn.historical_sync_status,
    windowDays: conn.historical_sync_window_days,
    startedAt: conn.historical_sync_started_at?.toISOString() ?? null,
    completedAt: conn.historical_sync_completed_at?.toISOString() ?? null,
    discoveredCount: conn.historical_sync_discovered_count,
    importedCount: conn.historical_sync_imported_count,
    lastError: conn.historical_sync_last_error,
  };
}

async function queueHistoricalSync(
  workspaceId: string,
  requestedBy: "auto_connect" | "manual",
): Promise<{
  connection: FathomConnectionRow | null;
  enqueued: boolean;
  error: string | null;
}> {
  const queuedConnection = await db.queueFathomHistoricalSync(
    workspaceId,
    HISTORICAL_SYNC_WINDOW_DAYS,
  );
  if (!queuedConnection) {
    return {
      connection: await db.getFathomConnection(workspaceId),
      enqueued: false,
      error: null,
    };
  }

  try {
    await enqueueMeetingHistoricalSync({
      workspaceId,
      windowDays: HISTORICAL_SYNC_WINDOW_DAYS,
      requestedBy,
    });
    return {
      connection:
        (await db.getFathomConnection(workspaceId)) ?? queuedConnection,
      enqueued: true,
      error: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    await db.failFathomHistoricalSync(workspaceId, {
      windowDays: HISTORICAL_SYNC_WINDOW_DAYS,
      lastError: errMsg,
    });
    log.error(
      { workspaceId, requestedBy, err: errMsg },
      "Failed to enqueue historical Fathom sync",
    );
    return {
      connection: await db.getFathomConnection(workspaceId),
      enqueued: false,
      error: errMsg,
    };
  }
}

function isValidFathomSignature(params: {
  rawBody: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  webhookSecret: string;
}): boolean {
  const secretBytes = Buffer.from(
    params.webhookSecret.replace(/^whsec_/, ""),
    "base64",
  );
  const signedContent = `${params.webhookId}.${params.webhookTimestamp}.${params.rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");
  const expectedHash = crypto
    .createHash("sha256")
    .update(expectedSignature)
    .digest();

  const signatures = params.webhookSignature
    .split(/\s+/)
    .map((sig) => sig.replace(/^v1,/, ""))
    .filter((sig) => sig.length > 0);

  return signatures.some((signature) => {
    const signatureHash = crypto
      .createHash("sha256")
      .update(signature)
      .digest();
    return crypto.timingSafeEqual(signatureHash, expectedHash);
  });
}

// ─── Shared webhook handler ─────────────────────────────────────────────────

async function handleFathomWebhook(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<void> {
  try {
    const rawBody = getRawBody(req);
    if (!rawBody) {
      res.status(400).json({ error: "empty_body" });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "invalid_json" });
      return;
    }

    const conn = await db.getFathomConnection(workspaceId);
    if (!conn || conn.status !== "active") {
      log.warn(
        { workspaceId },
        "Fathom webhook for inactive/unknown workspace",
      );
      res.status(200).json({ status: "connection_inactive" });
      return;
    }

    const webhookId = req.get("webhook-id");
    const webhookTimestamp = req.get("webhook-timestamp");
    const webhookSignature = req.get("webhook-signature");

    if (
      !config.FATHOM_ALLOW_INSECURE_WEBHOOKS &&
      (!webhookId || !webhookTimestamp || !webhookSignature)
    ) {
      res.status(401).json({ error: "missing_webhook_headers" });
      return;
    }

    if (!config.FATHOM_ALLOW_INSECURE_WEBHOOKS) {
      const timestampSec = parseInt(webhookTimestamp ?? "0", 10);
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - timestampSec) > 300) {
        res.status(401).json({ error: "webhook_timestamp_expired" });
        return;
      }
    }

    if (!config.FATHOM_ALLOW_INSECURE_WEBHOOKS) {
      const webhookSecret =
        (await getFathomWebhookSecret(workspaceId)) ||
        config.FATHOM_WEBHOOK_SECRET ||
        null;
      if (!webhookSecret) {
        log.error(
          { workspaceId },
          "No Fathom webhook secret configured for workspace",
        );
        res.status(500).json({ error: "webhook_secret_not_configured" });
        return;
      }

      const verified = isValidFathomSignature({
        rawBody,
        webhookId: webhookId ?? "",
        webhookTimestamp: webhookTimestamp ?? "",
        webhookSignature: webhookSignature ?? "",
        webhookSecret,
      });
      if (!verified) {
        log.warn("Fathom webhook signature verification failed");
        res.status(401).json({ error: "invalid_signature" });
        return;
      }
    }

    const recordingId = payload?.recording_id ?? payload?.recordingId;
    if (!recordingId) {
      log.warn("Fathom webhook missing recording_id");
      res.status(400).json({ error: "missing_recording_id" });
      return;
    }

    await enqueueMeetingIngest({
      workspaceId,
      fathomCallId: String(recordingId),
      source: "webhook",
      payload,
    });

    log.info(
      { workspaceId, recordingId },
      "Fathom webhook processed, meeting ingest enqueued",
    );

    res.status(200).json({ status: "accepted" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Fathom webhook handler error");
    res.status(500).json({ error: "internal_error" });
  }
}

// ─── Webhook Endpoints ───────────────────────────────────────────────────────

// Multi-tenant: each customer's Fathom webhook points to their unique URL
fathomWebhookRouter.post(
  "/:workspaceId",
  async (req: Request, res: Response) => {
    const workspaceId = String(req.params.workspaceId);
    if (!workspaceId) {
      res.status(400).json({ error: "workspace_id_required" });
      return;
    }
    await handleFathomWebhook(req, res, workspaceId);
  },
);

// ─── Connection Management (requires auth) ───────────────────────────────────

fathomRouter.get("/connection", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const conn = await db.getFathomConnection(workspaceId);
    if (!conn) {
      res.status(200).json({ connected: false });
      return;
    }

    const connected = conn.status === "active";
    res.status(200).json({
      connected,
      status: conn.status,
      fathomUserEmail: conn.fathom_user_email,
      webhookConfigured: connected ? Boolean(conn.webhook_id) : false,
      webhookUrl: connected ? getWebhookUrl(workspaceId) : null,
      defaultChannelId: conn.default_channel_id,
      lastSyncedAt: conn.last_synced_at?.toISOString() ?? null,
      lastError: conn.last_error,
      historicalSync: buildHistoricalSyncPayload(conn),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to get Fathom connection");
    sendFathomError(
      res,
      500,
      "internal_error",
      "Something went wrong while loading the Fathom connection.",
    );
  }
});

fathomRouter.patch("/connection", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const { default_channel_id } = req.body;
    if (default_channel_id !== undefined) {
      await db.updateFathomDefaultChannel(
        workspaceId,
        default_channel_id || null,
      );
    }

    res.json({ status: "updated" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to update Fathom connection");
    sendFathomError(
      res,
      500,
      "internal_error",
      "Couldn’t update the Fathom settings right now. Please try again.",
    );
  }
});

fathomRouter.post("/connection", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const existingConnection = await db.getFathomConnection(workspaceId);
    const { api_key, email, default_channel_id } = req.body ?? {};
    if (!api_key) {
      sendFathomError(
        res,
        400,
        "api_key_required",
        "Enter a Fathom API key to continue.",
      );
      return;
    }

    const validation = await validateFathomApiKey(api_key);
    if (validation.status === "invalid") {
      sendFathomError(
        res,
        400,
        "invalid_api_key",
        "That Fathom API key was rejected. Double-check it and try again.",
      );
      return;
    }
    if (validation.status === "retryable") {
      sendFathomError(
        res,
        502,
        "fathom_unavailable",
        "Fathom didn’t respond right now. Please try again in a moment.",
      );
      return;
    }

    const webhookUrl = getWebhookUrl(workspaceId);
    if (!webhookUrl) {
      sendFathomError(
        res,
        500,
        "public_base_url_not_configured",
        "Set PUBLIC_BASE_URL on the backend before connecting Fathom.",
      );
      return;
    }

    await storeFathomApiKey(workspaceId, api_key, email);
    if (default_channel_id !== undefined) {
      await db.updateFathomDefaultChannel(
        workspaceId,
        default_channel_id || null,
      );
    }

    const webhookResult = await registerFathomWebhook(workspaceId, webhookUrl);
    let connection = await db.getFathomConnection(workspaceId);

    if (existingConnection?.historical_sync_status !== "completed") {
      if (existingConnection && isHistoricalSyncLeaseStale(existingConnection)) {
        const recoveredSync = await recoverHistoricalSyncLease({
          workspaceId,
          connection: existingConnection,
          requestedBy: "auto_connect",
          reason: "auto_connect",
        });
        connection = recoveredSync.connection ?? connection;
      } else {
        const syncResult = await queueHistoricalSync(workspaceId, "auto_connect");
        connection = syncResult.connection ?? connection;
      }
    }

    res.status(200).json({
      connected: true,
      webhookRegistered: Boolean(webhookResult),
      webhookUrl,
      historicalSync: connection
        ? buildHistoricalSyncPayload(connection)
        : null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to create Fathom connection");
    sendFathomError(
      res,
      500,
      "internal_error",
      "Couldn’t connect Fathom right now. Please try again.",
    );
  }
});

fathomRouter.post("/connection/sync", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const connection = await db.getFathomConnection(workspaceId);
    if (!connection || connection.status !== "active") {
      sendFathomError(
        res,
        400,
        "fathom_not_connected",
        "Connect Fathom before starting a historical import.",
      );
      return;
    }

    if (
      connection.historical_sync_status === "queued" ||
      connection.historical_sync_status === "running"
    ) {
      const recoveredSync = await recoverHistoricalSyncLease({
        workspaceId,
        connection,
        requestedBy: "manual",
        reason: "manual_retry",
      });
      if (recoveredSync.error) {
        sendFathomError(
          res,
          500,
          "historical_sync_enqueue_failed",
          "The previous historical import became stuck and PulseBoard could not restart it automatically.",
        );
        return;
      }

      if (recoveredSync.recovered) {
        res.status(202).json({
          connected: true,
          historicalSync: buildHistoricalSyncPayload(
            recoveredSync.connection ?? connection,
          ),
        });
        return;
      }

      res.status(202).json({
        connected: true,
        historicalSync: buildHistoricalSyncPayload(connection),
      });
      return;
    }

    const syncResult = await queueHistoricalSync(workspaceId, "manual");
    if (syncResult.error) {
      sendFathomError(
        res,
        500,
        "historical_sync_enqueue_failed",
        "Couldn’t start the historical import. Please try again in a moment.",
      );
      return;
    }

    res.status(202).json({
      connected: true,
      historicalSync: syncResult.connection
        ? buildHistoricalSyncPayload(syncResult.connection)
        : buildHistoricalSyncPayload(connection),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to start historical Fathom sync");
    sendFathomError(
      res,
      500,
      "internal_error",
      "Couldn’t start the historical import. Please try again.",
    );
  }
});

fathomRouter.delete("/connection", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    await revokeFathomConnection(workspaceId);
    res.status(200).json({ status: "revoked" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to delete Fathom connection");
    sendFathomError(
      res,
      500,
      "internal_error",
      "Couldn’t disconnect Fathom right now. Please try again.",
    );
  }
});
