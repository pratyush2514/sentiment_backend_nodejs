import crypto from "node:crypto";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Request, Response, NextFunction } from "express";

const log = logger.child({ middleware: "apiAuth" });

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Pad shorter buffer to match length for constant-time comparison.
    // Without this, an attacker can brute-force token length via timing.
    const padded = Buffer.alloc(bufA.length, 0);
    bufB.copy(padded, 0, 0, Math.min(bufB.length, bufA.length));
    crypto.timingSafeEqual(bufA, padded);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

interface SupabaseJwtPayload {
  workspaceId: string;
  userId: string;
  email?: string;
  name?: string;
}

export function getWorkspaceIdFromRequest(req: Request): string | undefined {
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

  return undefined;
}

/**
 * Verify a Supabase Auth JWT signed with SUPABASE_JWT_SECRET.
 * Extracts userId (sub), email, name, and workspace/team ID from Slack OAuth metadata.
 */
async function verifySupabaseJwt(token: string): Promise<SupabaseJwtPayload | null> {
  if (!config.SUPABASE_JWT_SECRET) return null;

  try {
    const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);

    if (payload.aud !== "authenticated" || payload.role !== "authenticated") {
      return null;
    }

    const userId = payload.sub;
    if (!userId) return null;

    const meta = payload.user_metadata as Record<string, unknown> | undefined;

    // Slack team_id can appear in several places depending on Supabase's provider mapping
    const workspaceId =
      (meta?.team_id as string | undefined) ??
      (meta?.["https://slack.com/team_id"] as string | undefined);

    if (!workspaceId) {
      log.warn({ userId }, "JWT missing workspace/team_id — rejecting");
      return null;
    }

    return {
      userId,
      workspaceId,
      email: (payload.email ?? meta?.email) as string | undefined,
      name: (meta?.name ?? meta?.full_name) as string | undefined,
    };
  } catch {
    return null;
  }
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.get("Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

function rejectMissingWorkspace(req: Request, res: Response): void {
  res.status(400).json({
    error: "missing_workspace_id",
    message:
      "workspace_id query parameter or workspaceId/workspace_id body field is required",
    requestId: req.id,
  });
}

function rejectMissingAuth(req: Request, res: Response): void {
  res.status(401).json({
    error: "missing_auth_token",
    message: "Authorization header with Bearer token required",
    requestId: req.id,
  });
}

function rejectInvalidAuth(req: Request, res: Response): void {
  res.status(403).json({
    error: "invalid_auth_token",
    message: "Invalid API authentication token",
    requestId: req.id,
  });
}

function applyServiceContext(
  req: Request,
  workspaceId: string,
  authMode: "service" | "development",
): void {
  req.workspaceId = workspaceId;
  req.userId = undefined;
  req.authMode = authMode;
}

export async function requireServiceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = getBearerToken(req);

  if (config.API_AUTH_TOKEN) {
    if (!token) {
      rejectMissingAuth(req, res);
      return;
    }
    if (!timingSafeEqual(token, config.API_AUTH_TOKEN)) {
      rejectInvalidAuth(req, res);
      return;
    }

    const workspaceId = getWorkspaceIdFromRequest(req);
    if (!workspaceId) {
      rejectMissingWorkspace(req, res);
      return;
    }

    applyServiceContext(req, workspaceId, "service");
    next();
    return;
  }

  if (config.NODE_ENV === "production") {
    log.error("No service authentication method configured in production");
    res.status(500).json({
      error: "server_misconfigured",
      message: "API authentication not configured",
      requestId: req.id,
    });
    return;
  }

  const workspaceId = getWorkspaceIdFromRequest(req);
  if (!workspaceId) {
    rejectMissingWorkspace(req, res);
    return;
  }

  applyServiceContext(req, workspaceId, "development");
  next();
}

/**
 * Dual-mode API auth middleware.
 * 1. If SUPABASE_JWT_SECRET is configured, try Supabase JWT verification first.
 * 2. Fall back to static API_AUTH_TOKEN Bearer check.
 * 3. In dev with no token configured, allow all requests.
 */
export async function requireApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getBearerToken(req);

  // Path 1: Supabase JWT verification
  if (token && config.SUPABASE_JWT_SECRET) {
    const jwtResult = await verifySupabaseJwt(token);
    if (jwtResult) {
      req.workspaceId = jwtResult.workspaceId;
      req.userId = jwtResult.userId;
      req.authMode = "user";
      next();
      return;
    }
  }

  await requireServiceAuth(req, res, next);
}
