import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "tokenEncryption" });

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Deterministic dev-only key — NOT secure, only for local development
const DEV_ENCRYPTION_KEY = "0".repeat(64);

function getEncryptionKey(): Buffer {
  const hex = config.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    if (config.NODE_ENV === "development") {
      log.warn("ENCRYPTION_KEY not set — using insecure dev-only key. Do NOT use in production.");
      return Buffer.from(DEV_ENCRYPTION_KEY, "hex");
    }
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext: string): {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
} {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  log.debug("Token encrypted successfully");

  return { ciphertext: encrypted, iv, tag };
}

export function decryptToken(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
): string {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
