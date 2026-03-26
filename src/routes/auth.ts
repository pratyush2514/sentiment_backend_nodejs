import { Router } from "express";
import { jwtVerify } from "jose";
import { z } from "zod/v4";
import { config } from "../config.js";
import * as db from "../db/queries.js";
import { requireServiceAuth } from "../middleware/apiAuth.js";
import { cancelWorkspaceJobs, enqueueChannelDiscovery } from "../queue/boss.js";
import { invalidateWorkspaceCache } from "../services/slackClientFactory.js";
import { encryptToken } from "../services/tokenEncryption.js";
import { logger } from "../utils/logger.js";
import type { Request, Response } from "express";

const log = logger.child({ route: "auth" });

export const authRouter = Router();

const verifyBody = z.object({
  token: z.string().min(1, "token is required"),
});

/**
 * POST /api/auth/verify
 * Verifies a Supabase Auth JWT (Slack OAuth) and returns workspace access info.
 * Used by the frontend to confirm session validity.
 */
authRouter.post("/verify", async (req: Request, res: Response) => {
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      details: parsed.error.issues,
      requestId: req.id,
    });
    return;
  }

  if (!config.SUPABASE_JWT_SECRET) {
    res.status(501).json({
      error: "not_configured",
      message: "JWT verification is not configured. Set SUPABASE_JWT_SECRET.",
      requestId: req.id,
    });
    return;
  }

  try {
    const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(parsed.data.token, secret);

    const userId = payload.sub;
    if (!userId) {
      res.status(401).json({
        valid: false,
        error: "invalid_token",
        message: "Token does not contain a user identifier",
        requestId: req.id,
      });
      return;
    }

    const meta = payload.user_metadata as Record<string, unknown> | undefined;

    const workspaceId =
      (meta?.team_id as string | undefined) ??
      (meta?.["https://slack.com/team_id"] as string | undefined);

    if (!workspaceId) {
      res.status(400).json({
        valid: false,
        error: "missing_workspace",
        message: "Token does not contain a workspace identifier",
        requestId: req.id,
      });
      return;
    }

    const name = (meta?.name ?? meta?.full_name) as string | undefined;
    const email = (payload.email ?? meta?.email) as string | undefined;

    log.info({ userId, workspaceId }, "Supabase JWT verified");

    res.json({
      valid: true,
      workspaceId,
      userId,
      name: name ?? null,
      email: email ?? null,
    });
  } catch (err) {
    log.warn({ err }, "JWT verification failed");
    res.status(401).json({
      valid: false,
      error: "invalid_token",
      message: "Token verification failed",
      requestId: req.id,
    });
  }
});

// ─── Bot Installation ─────────────────────────────────────────────────────────

const installBody = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  teamName: z.string().optional(),
  botToken: z.string().min(1, "botToken is required"),
  refreshToken: z.string().min(1).optional().nullable(),
  accessTokenExpiresAt: z.string().datetime().optional().nullable(),
  expiresInSeconds: z.coerce.number().int().positive().optional().nullable(),
  tokenType: z.string().optional().nullable(),
  botUserId: z.string().optional(),
  installedBy: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

/**
 * POST /api/auth/install
 * Accepts a bot token from the frontend OAuth install callback,
 * encrypts it with AES-256-GCM, and stores it in the workspaces table.
 * Idempotent — repeated calls for the same workspace update the stored token.
 */
authRouter.post("/install", requireServiceAuth, async (req: Request, res: Response) => {
  const parsed = installBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      details: parsed.error.issues,
      requestId: req.id,
    });
    return;
  }

  if (!config.ENCRYPTION_KEY) {
    res.status(501).json({
      error: "not_configured",
      message: "ENCRYPTION_KEY is not set. Cannot store bot tokens securely.",
      requestId: req.id,
    });
    return;
  }

  try {
    const {
      workspaceId: requestedWorkspaceId,
      teamName,
      botToken,
      refreshToken,
      accessTokenExpiresAt,
      expiresInSeconds,
      botUserId,
      installedBy,
      scopes,
    } = parsed.data;
    const workspaceId = req.workspaceId;

    if (!workspaceId || requestedWorkspaceId !== workspaceId) {
      res.status(403).json({
        error: "workspace_mismatch",
        message: "Authenticated workspace does not match install payload",
        requestId: req.id,
      });
      return;
    }

    if (config.NODE_ENV === "production") {
      if (!refreshToken) {
        res.status(400).json({
          error: "refresh_token_required",
          message:
            "Slack OAuth install must include a refresh token in production. Reinstall the app with token rotation enabled.",
          requestId: req.id,
        });
        return;
      }

      if (!accessTokenExpiresAt && typeof expiresInSeconds !== "number") {
        res.status(400).json({
          error: "token_expiry_required",
          message:
            "Slack OAuth install must include token expiry metadata in production.",
          requestId: req.id,
        });
        return;
      }
    }

    const encryptedAccessToken = encryptToken(botToken);
    const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;
    const resolvedExpiresAt =
      accessTokenExpiresAt
        ? new Date(accessTokenExpiresAt)
        : typeof expiresInSeconds === "number"
          ? new Date(Date.now() + expiresInSeconds * 1000)
          : null;

    await db.upsertWorkspace({
      workspaceId,
      teamName: teamName ?? null,
      botTokenEncrypted: encryptedAccessToken.ciphertext,
      botTokenIv: encryptedAccessToken.iv,
      botTokenTag: encryptedAccessToken.tag,
      botRefreshTokenEncrypted: encryptedRefreshToken?.ciphertext ?? null,
      botRefreshTokenIv: encryptedRefreshToken?.iv ?? null,
      botRefreshTokenTag: encryptedRefreshToken?.tag ?? null,
      botTokenExpiresAt: resolvedExpiresAt,
      botUserId: botUserId ?? null,
      installedBy: installedBy ?? null,
      scopes: scopes ?? null,
    });

    // Invalidate any cached client so the next call picks up the new token
    invalidateWorkspaceCache(workspaceId);

    log.info(
      {
        workspaceId,
        installedBy,
        hasRefreshToken: Boolean(refreshToken),
        botTokenExpiresAt: resolvedExpiresAt?.toISOString() ?? null,
      },
      "Bot token installed for workspace",
    );

    // Auto-discover channels for this workspace
    enqueueChannelDiscovery(workspaceId, "install").catch((err) =>
      log.warn({ err, workspaceId }, "Failed to enqueue channel discovery"),
    );

    res.json({ ok: true, workspaceId });
  } catch (err) {
    log.error({ err }, "Failed to install bot token");
    res.status(500).json({
      error: "install_failed",
      message: "Failed to store bot token. Please try again.",
      requestId: req.id,
    });
  }
});

/**
 * GET /api/auth/workspace-status?workspace_id=T1234
 * Returns whether a workspace has a bot installation.
 */
authRouter.get("/workspace-status", requireServiceAuth, async (req: Request, res: Response) => {
  const workspaceId = req.workspaceId;
  if (!workspaceId) {
    res.status(400).json({
      error: "missing_workspace_id",
      message: "workspace_id is required",
      requestId: req.id,
    });
    return;
  }

  try {
    const status = await db.getWorkspaceStatus(workspaceId);
    res.json({ ok: true, ...status });
  } catch (err) {
    log.error({ err, workspaceId }, "Failed to check workspace status");
    res.status(500).json({
      error: "status_check_failed",
      message: "Failed to check workspace status",
      requestId: req.id,
    });
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/logout
 * Ends the caller's app session without affecting shared workspace processing.
 * Workspace jobs continue running so other active users and background flows
 * are not disrupted by an individual logout.
 */
authRouter.post("/logout", requireServiceAuth, async (req: Request, res: Response) => {
  const workspaceId = req.workspaceId;
  log.info({ workspaceId }, "Workspace logout acknowledged without queue cancellation");
  res.json({ ok: true, sessionCleared: true, workspaceId });
});

// ─── Disconnect Workspace ────────────────────────────────────────────────────

/**
 * DELETE /api/auth/disconnect
 * Nuclear option: deletes ALL workspace data (channels, messages, analytics,
 * roles, follow-ups, costs) and the workspace record itself. Also cancels
 * all pending queue jobs. The user must re-install the bot to use the app again.
 */
authRouter.delete("/disconnect", requireServiceAuth, async (req: Request, res: Response) => {
  const workspaceId = req.workspaceId;
  if (!workspaceId) {
    res.status(400).json({ error: "missing_workspace_id", requestId: req.id });
    return;
  }

  try {
    // 1. Cancel all pending queue jobs
    const cancelled = await cancelWorkspaceJobs(workspaceId);

    // 2. Invalidate the cached Slack client
    invalidateWorkspaceCache(workspaceId);

    // 3. Delete all workspace data
    await db.deleteWorkspaceCascade(workspaceId);

    log.info({ workspaceId, cancelled }, "Workspace disconnected — all data deleted");
    res.json({ ok: true, cancelled });
  } catch (err) {
    log.error({ err, workspaceId }, "Failed to disconnect workspace");
    res.status(500).json({
      error: "disconnect_failed",
      message: "Failed to disconnect workspace. Please try again.",
      requestId: req.id,
    });
  }
});
