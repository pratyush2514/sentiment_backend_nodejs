import { config } from "../config.js";
import { pool } from "../db/pool.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { decryptToken, encryptToken } from "./tokenEncryption.js";
import type {
  WorkspaceRow,
  WorkspaceTokenRotationStatus,
} from "../types/database.js";
import type { PoolClient } from "pg";

const log = logger.child({ service: "slackTokenManager" });

const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const WORKSPACE_TOKEN_LOCK_NAMESPACE = 82431;

type WorkspaceCredentialRow = Pick<
  WorkspaceRow,
  | "workspace_id"
  | "team_name"
  | "bot_token_encrypted"
  | "bot_token_iv"
  | "bot_token_tag"
  | "bot_refresh_token_encrypted"
  | "bot_refresh_token_iv"
  | "bot_refresh_token_tag"
  | "bot_token_expires_at"
  | "bot_user_id"
  | "install_status"
  | "last_token_refresh_at"
  | "last_token_refresh_error"
  | "last_token_refresh_error_at"
>;

export type SlackTokenRotationErrorCode =
  | "workspace_not_installed"
  | "legacy_reinstall_required"
  | "refresh_failed"
  | "expired_or_invalid"
  | "not_configured";

export class SlackTokenRotationError extends Error {
  constructor(
    public readonly code: SlackTokenRotationErrorCode,
    message: string,
    public readonly workspaceId?: string,
    public readonly slackError?: string | null,
  ) {
    super(message);
    this.name = "SlackTokenRotationError";
  }
}

export interface ResolvedWorkspaceBotToken {
  botToken: string;
  botUserId: string | null;
  botTokenExpiresAt: Date | null;
  tokenRotationStatus: WorkspaceTokenRotationStatus;
}

interface SlackRefreshResponse {
  ok: boolean;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  bot_user_id?: string;
  token_type?: string;
  error?: string;
}

interface SlackRefreshSuccessResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  bot_user_id?: string;
  token_type?: string;
}

function getRefreshBufferMs(): number {
  return config.SLACK_TOKEN_REFRESH_BUFFER_MINUTES * 60 * 1000;
}

function isTokenWithinRefreshBuffer(expiresAt?: Date | null): boolean {
  if (!expiresAt) {
    return false;
  }

  return expiresAt.getTime() <= Date.now() + getRefreshBufferMs();
}

export function deriveWorkspaceTokenRotationStatus(
  row?: WorkspaceCredentialRow | null,
): WorkspaceTokenRotationStatus {
  if (!row || row.install_status !== "active") {
    return "expired_or_invalid";
  }

  if (!row.bot_refresh_token_encrypted) {
    return "legacy_reinstall_required";
  }

  if (row.bot_token_expires_at && row.bot_token_expires_at.getTime() <= Date.now()) {
    return "expired_or_invalid";
  }

  if (row.last_token_refresh_error) {
    return "refresh_failed";
  }

  return "ready";
}

function ensureRotationConfig(): void {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    throw new SlackTokenRotationError(
      "not_configured",
      "Slack token rotation is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.",
    );
  }
}

function decryptWorkspaceAccessToken(row: WorkspaceCredentialRow): string {
  return decryptToken(
    row.bot_token_encrypted,
    row.bot_token_iv,
    row.bot_token_tag,
  );
}

function decryptWorkspaceRefreshToken(row: WorkspaceCredentialRow): string {
  if (
    !row.bot_refresh_token_encrypted ||
    !row.bot_refresh_token_iv ||
    !row.bot_refresh_token_tag
  ) {
    throw new SlackTokenRotationError(
      "legacy_reinstall_required",
      `Workspace ${row.workspace_id} must be reinstalled to enable Slack token rotation.`,
      row.workspace_id,
    );
  }

  return decryptToken(
    row.bot_refresh_token_encrypted,
    row.bot_refresh_token_iv,
    row.bot_refresh_token_tag,
  );
}

async function fetchWorkspaceCredentialRow(
  workspaceId: string,
): Promise<WorkspaceCredentialRow | null> {
  const row = await db.getWorkspaceBotCredentials(workspaceId);
  return row;
}

async function fetchWorkspaceCredentialRowForUpdate(
  client: { query: typeof pool.query },
  workspaceId: string,
): Promise<WorkspaceCredentialRow | null> {
  const result = await client.query<WorkspaceCredentialRow>(
    `SELECT
       workspace_id,
       team_name,
       bot_token_encrypted,
       bot_token_iv,
       bot_token_tag,
       bot_refresh_token_encrypted,
       bot_refresh_token_iv,
       bot_refresh_token_tag,
       bot_token_expires_at,
       bot_user_id,
       install_status,
       last_token_refresh_at,
       last_token_refresh_error,
       last_token_refresh_error_at
     FROM workspaces
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

async function withWorkspaceTokenLock<T>(
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      `SELECT pg_advisory_lock($1, hashtext($2))`,
      [WORKSPACE_TOKEN_LOCK_NAMESPACE, workspaceId],
    );
    return await work(client);
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
        WORKSPACE_TOKEN_LOCK_NAMESPACE,
        workspaceId,
      ])
      .catch(() => undefined);
    client.release();
  }
}

async function postSlackRefreshToken(refreshToken: string): Promise<SlackRefreshSuccessResponse> {
  ensureRotationConfig();

  const basicAuth = Buffer.from(
    `${config.SLACK_CLIENT_ID}:${config.SLACK_CLIENT_SECRET}`,
    "utf8",
  ).toString("base64");

  const response = await fetch(SLACK_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new SlackTokenRotationError(
      "refresh_failed",
      `Slack token refresh failed with HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as SlackRefreshResponse;
  if (!payload.ok || !payload.access_token || !payload.refresh_token) {
    throw new SlackTokenRotationError(
      "refresh_failed",
      `Slack token refresh failed: ${payload.error ?? "unknown_error"}`,
      undefined,
      payload.error ?? null,
    );
  }

  return {
    ok: true,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: payload.expires_in,
    bot_user_id: payload.bot_user_id,
    token_type: payload.token_type,
  };
}

export async function getUsableBotToken(
  workspaceId: string,
): Promise<ResolvedWorkspaceBotToken> {
  const row = await fetchWorkspaceCredentialRow(workspaceId);

  if (row && row.install_status === "active") {
    const status = deriveWorkspaceTokenRotationStatus(row);

    if (status === "legacy_reinstall_required") {
      throw new SlackTokenRotationError(
        "legacy_reinstall_required",
        `Workspace ${workspaceId} must be reinstalled to enable Slack token rotation.`,
        workspaceId,
      );
    }

    if (status === "expired_or_invalid" || isTokenWithinRefreshBuffer(row.bot_token_expires_at)) {
      return refreshWorkspaceBotToken(workspaceId, { reason: "proactive" });
    }

    return {
      botToken: decryptWorkspaceAccessToken(row),
      botUserId: row.bot_user_id,
      botTokenExpiresAt: row.bot_token_expires_at,
      tokenRotationStatus: status,
    };
  }

  if (config.NODE_ENV !== "production" && config.SLACK_BOT_TOKEN) {
    log.warn(
      { workspaceId },
      "No active rotating workspace install found; falling back to SLACK_BOT_TOKEN in non-production mode",
    );
    return {
      botToken: config.SLACK_BOT_TOKEN,
      botUserId: config.SLACK_BOT_USER_ID || null,
      botTokenExpiresAt: null,
      tokenRotationStatus: "ready",
    };
  }

  throw new SlackTokenRotationError(
    "workspace_not_installed",
    `No active Slack workspace install found for workspace ${workspaceId}.`,
    workspaceId,
  );
}

export async function refreshWorkspaceBotToken(
  workspaceId: string,
  options?: { reason?: "proactive" | "auth_failure" | "scheduler" | "manual" },
): Promise<ResolvedWorkspaceBotToken> {
  const reason = options?.reason ?? "manual";

  return withWorkspaceTokenLock(workspaceId, async (client) => {
    const row = await fetchWorkspaceCredentialRowForUpdate(client, workspaceId);
    const status = deriveWorkspaceTokenRotationStatus(row);

    if (!row || row.install_status !== "active") {
      throw new SlackTokenRotationError(
        "workspace_not_installed",
        `No active Slack workspace install found for workspace ${workspaceId}.`,
        workspaceId,
      );
    }

    if (status === "legacy_reinstall_required") {
      throw new SlackTokenRotationError(
        "legacy_reinstall_required",
        `Workspace ${workspaceId} must be reinstalled to enable Slack token rotation.`,
        workspaceId,
      );
    }

    if (
      reason !== "auth_failure" &&
      !isTokenWithinRefreshBuffer(row.bot_token_expires_at)
    ) {
      return {
        botToken: decryptWorkspaceAccessToken(row),
        botUserId: row.bot_user_id,
        botTokenExpiresAt: row.bot_token_expires_at,
        tokenRotationStatus: deriveWorkspaceTokenRotationStatus(row),
      };
    }

    try {
      const refreshToken = decryptWorkspaceRefreshToken(row);
      const refreshed = await postSlackRefreshToken(refreshToken);
      const accessEncrypted = encryptToken(refreshed.access_token);
      const refreshEncrypted = encryptToken(refreshed.refresh_token);
      const expiresAt =
        typeof refreshed.expires_in === "number" && Number.isFinite(refreshed.expires_in)
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null;

      await db.updateWorkspaceRotatedBotToken({
        workspaceId,
        botTokenEncrypted: accessEncrypted.ciphertext,
        botTokenIv: accessEncrypted.iv,
        botTokenTag: accessEncrypted.tag,
        botRefreshTokenEncrypted: refreshEncrypted.ciphertext,
        botRefreshTokenIv: refreshEncrypted.iv,
        botRefreshTokenTag: refreshEncrypted.tag,
        botTokenExpiresAt: expiresAt,
        botUserId: refreshed.bot_user_id ?? row.bot_user_id,
      });

      log.info(
        { workspaceId, reason, expiresAt: expiresAt?.toISOString() ?? null },
        "Refreshed Slack bot token for workspace",
      );

      return {
        botToken: refreshed.access_token,
        botUserId: refreshed.bot_user_id ?? row.bot_user_id,
        botTokenExpiresAt: expiresAt,
        tokenRotationStatus: "ready",
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Slack token refresh failure";
      await db.recordWorkspaceTokenRefreshFailure(workspaceId, message);
      log.warn({ workspaceId, reason, err: error }, "Slack bot token refresh failed");

      if (error instanceof SlackTokenRotationError) {
        throw new SlackTokenRotationError(
          error.code === "refresh_failed" ? "refresh_failed" : error.code,
          error.message,
          workspaceId,
          error.slackError,
        );
      }

      throw new SlackTokenRotationError(
        "refresh_failed",
        `Slack token refresh failed for workspace ${workspaceId}: ${message}`,
        workspaceId,
      );
    }
  });
}

export async function refreshExpiringWorkspaceBotTokens(
  limit: number = 50,
): Promise<{ attempted: number; refreshed: number; failed: number }> {
  const workspaceIds = await db.listExpiringWorkspaceIds(
    config.SLACK_TOKEN_REFRESH_LOOKAHEAD_MINUTES,
    limit,
  );

  let refreshed = 0;
  let failed = 0;

  for (const workspaceId of workspaceIds) {
    try {
      await refreshWorkspaceBotToken(workspaceId, { reason: "scheduler" });
      refreshed += 1;
    } catch (error) {
      failed += 1;
      log.warn({ workspaceId, err: error }, "Failed to refresh expiring Slack bot token");
    }
  }

  return {
    attempted: workspaceIds.length,
    refreshed,
    failed,
  };
}
