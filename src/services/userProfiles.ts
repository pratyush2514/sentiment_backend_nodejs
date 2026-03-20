import { PROFILE_CACHE_TTL_MS, PROFILE_MAX_CACHE_SIZE } from "../constants.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { UserProfileRow } from "../types/database.js";

const log = logger.child({ service: "userProfiles" });

// ─── In-memory cache with 24h TTL ───────────────────────────────────────────

interface CachedProfile {
  profile: UserProfileRow;
  cachedAt: number;
}

const CACHE_TTL_MS = PROFILE_CACHE_TTL_MS;
const MAX_CACHE_SIZE = PROFILE_MAX_CACHE_SIZE;
const profileCache = new Map<string, CachedProfile>();

function cacheKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

function setCacheEntry(key: string, entry: CachedProfile): void {
  // Evict oldest entry if at capacity
  if (profileCache.size >= MAX_CACHE_SIZE && !profileCache.has(key)) {
    const firstKey = profileCache.keys().next().value;
    if (firstKey !== undefined) {
      profileCache.delete(firstKey);
    }
  }
  // Delete and re-insert to move to end (most recent)
  profileCache.delete(key);
  profileCache.set(key, entry);
}

function isCacheValid(entry: CachedProfile): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function isDbProfileFresh(profile: UserProfileRow): boolean {
  return Date.now() - profile.fetched_at.getTime() < CACHE_TTL_MS;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve a user profile through the 3-tier cache:
 * 1. In-memory Map (hot, <24h TTL)
 * 2. DB user_profiles table (warm, <24h fetched_at)
 * 3. Slack users.info API (cold, always fresh)
 */
export async function resolveUserProfile(
  workspaceId: string,
  userId: string,
): Promise<UserProfileRow | null> {
  const key = cacheKey(workspaceId, userId);

  // Tier 1: In-memory cache
  const cached = profileCache.get(key);
  if (cached && isCacheValid(cached)) {
    return cached.profile;
  }

  // Tier 2: Database
  const dbProfile = await db.getUserProfile(workspaceId, userId);
  if (dbProfile && isDbProfileFresh(dbProfile)) {
    setCacheEntry(key, { profile: dbProfile, cachedAt: Date.now() });
    return dbProfile;
  }

  // Tier 3: Slack API
  return fetchAndCacheFromSlack(workspaceId, userId);
}

/**
 * Fetch user profile from Slack API, upsert to DB, and cache in memory.
 */
export async function fetchAndCacheFromSlack(
  workspaceId: string,
  userId: string,
): Promise<UserProfileRow | null> {
  const key = cacheKey(workspaceId, userId);

  try {
    const slack = await getSlackClient(workspaceId);
    const response = await slack.fetchUserProfile(userId);

    const displayName = response.user?.profile?.display_name || null;
    const realName = response.user?.profile?.real_name || null;
    const profileImage = response.user?.profile?.image_48 || null;
    const email = response.user?.profile?.email || null;
    const isAdmin = response.user?.is_admin ?? false;
    const isOwner = response.user?.is_owner ?? false;
    const isBot = response.user?.is_bot ?? false;

    const row = await db.upsertUserProfile(
      workspaceId,
      userId,
      displayName,
      realName,
      profileImage,
      email,
      isAdmin,
      isOwner,
      isBot,
    );

    setCacheEntry(key, { profile: row, cachedAt: Date.now() });
    return row;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn({ userId, error: errMsg }, "Failed to resolve user profile from Slack");
    return null;
  }
}

/**
 * Batch resolve multiple user IDs. Checks cache and DB first,
 * then fetches remaining from Slack API with controlled concurrency.
 */
export async function batchResolveUsers(
  workspaceId: string,
  userIds: string[],
  concurrency: number = 5,
): Promise<void> {
  const uniqueIds = [...new Set(userIds)];

  // Filter out already-cached
  const unresolvedIds = uniqueIds.filter((id) => {
    const cached = profileCache.get(cacheKey(workspaceId, id));
    return !cached || !isCacheValid(cached);
  });

  if (unresolvedIds.length === 0) return;

  // Check DB for remaining
  const dbProfiles = await db.getUserProfiles(workspaceId, unresolvedIds);
  const freshDbIds = new Set<string>();
  for (const profile of dbProfiles) {
    if (isDbProfileFresh(profile)) {
      setCacheEntry(cacheKey(workspaceId, profile.user_id), {
        profile,
        cachedAt: Date.now(),
      });
      freshDbIds.add(profile.user_id);
    }
  }

  // Remaining need Slack API calls
  const needApiIds = unresolvedIds.filter((id) => !freshDbIds.has(id));

  if (needApiIds.length === 0) {
    log.info({ resolved: unresolvedIds.length }, "All user profiles resolved from DB");
    return;
  }

  log.info(
    { total: uniqueIds.length, needApi: needApiIds.length, concurrency },
    "Batch resolving user profiles from Slack API",
  );

  // Resolve with controlled concurrency
  for (let i = 0; i < needApiIds.length; i += concurrency) {
    const batch = needApiIds.slice(i, i + concurrency);
    await Promise.all(
      batch.map((userId) => fetchAndCacheFromSlack(workspaceId, userId)),
    );
  }

  log.info({ resolved: needApiIds.length }, "Batch user profile resolution complete");
}
