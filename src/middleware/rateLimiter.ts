import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterHandle {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  cleanup: () => void;
}

/**
 * Simple in-memory rate limiter with cleanup support.
 * For production at scale, replace with Redis-backed limiter.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}): RateLimiterHandle {
  const { windowMs, max, keyFn } = options;
  const store = new Map<string, RateLimitEntry>();

  // Periodically clean expired entries to prevent memory leak
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, windowMs * 2);
  cleanupInterval.unref();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn ? keyFn(req) : (req.ip ?? "unknown");
    const now = Date.now();

    const entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "rate_limit_exceeded",
        message: `Too many requests. Try again in ${retryAfter}s.`,
      });
      return;
    }

    next();
  };

  const cleanup = () => {
    clearInterval(cleanupInterval);
    store.clear();
  };

  return { middleware, cleanup };
}
