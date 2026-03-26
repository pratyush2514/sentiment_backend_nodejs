import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { SlackClient } from "./slackClient.js";
import {
  getUsableBotToken,
  refreshWorkspaceBotToken,
  SlackTokenRotationError,
} from "./slackTokenManager.js";

const log = logger.child({ service: "slackClientFactory" });

interface CacheEntry {
  client: SlackClient;
  cachedAt: number;
  tokenExpiresAtMs: number | null;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;

const cache = new Map<string, CacheEntry>();

function isCacheEntryFresh(entry: CacheEntry): boolean {
  if (Date.now() - entry.cachedAt >= TOKEN_CACHE_TTL_MS) {
    return false;
  }

  if (entry.tokenExpiresAtMs === null) {
    return true;
  }

  const refreshBufferMs = config.SLACK_TOKEN_REFRESH_BUFFER_MINUTES * 60 * 1000;
  return entry.tokenExpiresAtMs > Date.now() + refreshBufferMs;
}

function evictStaleEntries(): void {
  if (cache.size <= MAX_CACHE_SIZE) return;

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }

  // If still over limit, evict oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const toEvict = entries.slice(0, cache.size - MAX_CACHE_SIZE);
    for (const [key] of toEvict) {
      cache.delete(key);
    }
  }
}

/**
 * Returns a workspace-scoped SlackClient with the correct bot token.
 *
 * Resolution order:
 * 1. In-memory LRU cache (5-min TTL)
 * 2. Database lookup + AES-256-GCM decryption
 * 3. Fallback to global config.SLACK_BOT_TOKEN (dev/single-tenant mode)
 * 4. Throw if no token available
 */
// Dedup concurrent fetches for the same workspace
const inFlightRequests = new Map<string, Promise<SlackClient>>();

export async function getSlackClient(workspaceId: string): Promise<SlackClient> {
  // 1. Check cache
  const cached = cache.get(workspaceId);
  if (cached && isCacheEntryFresh(cached)) {
    return cached.client;
  }

  // 1.5. Dedup: if another call is already fetching for this workspace, reuse that promise
  const inflight = inFlightRequests.get(workspaceId);
  if (inflight) return inflight;

  const fetchPromise = _fetchSlackClient(workspaceId);
  inFlightRequests.set(workspaceId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightRequests.delete(workspaceId);
  }
}

async function _fetchSlackClient(workspaceId: string): Promise<SlackClient> {
  // 2. Workspace-scoped rotating credentials
  try {
    const credentials = await getUsableBotToken(workspaceId);
    const client = new SlackClient(credentials.botToken, {
      onAuthFailure: async () => {
        const refreshed = await refreshWorkspaceBotToken(workspaceId, {
          reason: "auth_failure",
        });
        invalidateWorkspaceCache(workspaceId);
        return {
          token: refreshed.botToken,
          botUserId: refreshed.botUserId,
        };
      },
    });

    if (credentials.botUserId) {
      (client as unknown as { _botUserId: string | null })._botUserId =
        credentials.botUserId;
    }

    evictStaleEntries();
    cache.set(workspaceId, {
      client,
      cachedAt: Date.now(),
      tokenExpiresAtMs: credentials.botTokenExpiresAt?.getTime() ?? null,
    });

    log.debug({ workspaceId }, "Created workspace-scoped SlackClient from rotating credentials");
    return client;
  } catch (error) {
    if (
      !(error instanceof SlackTokenRotationError) ||
      error.code !== "workspace_not_installed" ||
      config.NODE_ENV === "production"
    ) {
      throw error;
    }
  }

  // 3. Fallback to global env token (dev/single-tenant only)
  if (config.SLACK_BOT_TOKEN) {
    log.warn(
      { workspaceId },
      "No workspace row in DB; falling back to global SLACK_BOT_TOKEN. Install the bot via OAuth for reliable multi-workspace support.",
    );
    const client = new SlackClient(config.SLACK_BOT_TOKEN);

    if (config.SLACK_BOT_USER_ID) {
      (client as unknown as { _botUserId: string | null })._botUserId = config.SLACK_BOT_USER_ID;
    }

    // Do NOT cache — fallback tokens must not be stored under workspace IDs they don't belong to
    return client;
  }

  // 4. No token available
  throw new Error(
    `No bot token available for workspace ${workspaceId}. ` +
      "Install the bot via the OAuth flow or set SLACK_BOT_TOKEN.",
  );
}

/**
 * Invalidate the cached client for a workspace.
 * Call this after a token update (e.g. re-installation).
 */
export function invalidateWorkspaceCache(workspaceId: string): void {
  cache.delete(workspaceId);
  log.info({ workspaceId }, "Invalidated workspace client cache");
}

/**
 * Clear the entire client cache. Useful for testing.
 */
export function clearClientCache(): void {
  cache.clear();
}
