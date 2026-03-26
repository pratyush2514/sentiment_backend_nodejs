import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { decryptToken, encryptToken } from "./tokenEncryption.js";

const log = logger.child({ service: "fathomTokenManager" });

function encodeEncryptedValue(plaintext: string): string {
  const { ciphertext, iv, tag } = encryptToken(plaintext);
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decodeEncryptedValue(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format");
  }
  const [ivB64, tagB64, ciphertextB64] = parts;
  return decryptToken(
    Buffer.from(ciphertextB64, "base64"),
    Buffer.from(ivB64, "base64"),
    Buffer.from(tagB64, "base64"),
  );
}

/**
 * Encrypt and store a Fathom API key for a workspace.
 */
export async function storeFathomApiKey(
  workspaceId: string,
  apiKey: string,
  fathomUserEmail?: string | null,
): Promise<void> {
  const encrypted = encodeEncryptedValue(apiKey);

  await db.upsertFathomConnection(workspaceId, encrypted, fathomUserEmail);
  log.info({ workspaceId }, "Fathom API key stored");
}

export async function storeFathomWebhookSecret(
  workspaceId: string,
  webhookId: string,
  webhookSecret: string,
): Promise<void> {
  const storedSecret = webhookSecret
    ? encodeEncryptedValue(webhookSecret)
    : webhookSecret;
  await db.updateFathomConnectionWebhook(workspaceId, webhookId, storedSecret);
}

/**
 * Retrieve and decrypt the Fathom API key for a workspace.
 * Returns null if no connection exists or connection is not active.
 */
export async function getFathomApiKey(
  workspaceId: string,
): Promise<string | null> {
  const conn = await db.getFathomConnection(workspaceId);
  if (!conn || conn.status !== "active") {
    return null;
  }

  try {
    return decodeEncryptedValue(conn.encrypted_api_key);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, err: errMsg }, "Failed to decrypt Fathom API key");
    await db.updateFathomConnectionStatus(workspaceId, "invalid", errMsg);
    return null;
  }
}

/**
 * Mark a Fathom connection as invalid (e.g., after auth failure).
 */
export async function invalidateFathomConnection(
  workspaceId: string,
  reason: string,
): Promise<void> {
  await db.updateFathomConnectionStatus(workspaceId, "invalid", reason);
  log.warn({ workspaceId, reason }, "Fathom connection invalidated");
}

export async function getFathomWebhookSecret(
  workspaceId: string,
): Promise<string | null> {
  const conn = await db.getFathomConnection(workspaceId);
  const storedSecret = conn?.webhook_secret ?? null;
  if (!storedSecret) {
    return null;
  }

  try {
    return decodeEncryptedValue(storedSecret);
  } catch {
    // Legacy plaintext secrets are still readable during rollout.
    return storedSecret;
  }
}

/**
 * Revoke a Fathom connection while preserving workspace-level sync metadata.
 */
export async function revokeFathomConnection(
  workspaceId: string,
): Promise<void> {
  await db.deleteFathomConnection(workspaceId);
  log.info({ workspaceId }, "Fathom connection revoked");
}
