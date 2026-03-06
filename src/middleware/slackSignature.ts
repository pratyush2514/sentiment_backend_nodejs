import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Request, Response, NextFunction } from "express";

export function getRawBody(req: Request): string {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return "";
}

export function isValidSlackSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computedSignature = `v0=${crypto
    .createHmac("sha256", config.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest("hex")}`;

  // Hash both sides to guarantee constant-time comparison regardless of input length
  const signatureHash = crypto.createHash("sha256").update(signature).digest();
  const computedHash = crypto.createHash("sha256").update(computedSignature).digest();

  return crypto.timingSafeEqual(signatureHash, computedHash);
}

export function verifySlackSignature(req: Request, res: Response, next: NextFunction): void {
  const rawBody = getRawBody(req);
  const timestamp = req.get("X-Slack-Request-Timestamp");
  const signature = req.get("X-Slack-Signature");

  if (!timestamp || !signature) {
    logger.warn("Missing Slack signature headers");
    res.status(401).send("Missing signature headers");
    return;
  }

  if (!isValidSlackSignature(rawBody, timestamp, signature)) {
    logger.warn("Invalid Slack signature");
    res.status(401).send("Invalid Slack signature");
    return;
  }

  next();
}
