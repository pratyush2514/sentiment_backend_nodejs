import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Request, Response, NextFunction } from "express";

const log = logger.child({ middleware: "apiAuth" });

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no token configured
  if (!config.API_AUTH_TOKEN) {
    if (config.NODE_ENV === "production") {
      log.error("API_AUTH_TOKEN not set in production");
      res.status(500).json({ error: "server_misconfigured", message: "API authentication not configured", requestId: req.id });
      return;
    }
    next();
    return;
  }

  const authHeader = req.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_auth_token", message: "Authorization header with Bearer token required", requestId: req.id });
    return;
  }

  const token = authHeader.slice(7);
  if (!timingSafeEqual(token, config.API_AUTH_TOKEN)) {
    res.status(403).json({ error: "invalid_auth_token", message: "Invalid API authentication token", requestId: req.id });
    return;
  }

  next();
}
