import * as db from "../db/queries.js";
import { enqueueBackfill } from "../queue/boss.js";
import { logger } from "../utils/logger.js";
import { getSlackClient } from "./slackClientFactory.js";

const log = logger.child({ service: "channelDiscovery" });

const DISCOVERY_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
const MAX_COOLDOWN_ENTRIES = 100;
const lastDiscoveryAt = new Map<string, number>();

/** Evict stale cooldown entries to prevent unbounded growth */
function pruneDiscoveryCooldowns(): void {
  if (lastDiscoveryAt.size <= MAX_COOLDOWN_ENTRIES) return;
  const now = Date.now();
  for (const [key, ts] of lastDiscoveryAt) {
    if (now - ts > DISCOVERY_COOLDOWN_MS) lastDiscoveryAt.delete(key);
  }
}

export interface DiscoveryResult {
  discovered: number;
  totalVisible: number;
  alreadyTracked: number;
  newlyTracked: number;
  channels: Array<{ id: string; name: string; jobId: string | null }>;
}

/**
 * Discovers all public and private channels the bot is a member of via `users.conversations`,
 * upserts any new ones into the DB, and enqueues backfill jobs for them.
 *
 * Extracted from `POST /api/channels/sync` so it can be called from both
 * the HTTP endpoint and the pg-boss channel discovery job.
 */
export async function discoverChannels(workspaceId: string): Promise<DiscoveryResult> {
  // In-memory cooldown: skip if discovery ran within the last 3 minutes
  // BUT always allow discovery when no channels are tracked yet (fresh install)
  const lastRun = lastDiscoveryAt.get(workspaceId);
  if (lastRun && Date.now() - lastRun < DISCOVERY_COOLDOWN_MS) {
    const existingRows = await db.getAllChannelsWithState(workspaceId);
    if (existingRows.length > 0) {
      log.info({ workspaceId, lastRunAgo: Math.round((Date.now() - lastRun) / 1000) }, "Discovery skipped (cooldown)");
      return {
        discovered: existingRows.length,
        totalVisible: 0,
        alreadyTracked: existingRows.length,
        newlyTracked: 0,
        channels: [],
      };
    }
    log.info({ workspaceId }, "Cooldown bypassed — no channels tracked yet (fresh install)");
  }

  const slack = await getSlackClient(workspaceId);

  // Use users.conversations to fetch ONLY channels the bot is a member of.
  // This is far more efficient than conversations.list (which returns ALL channels).
  let memberChannels: Array<{ id: string; name: string; is_private?: boolean }> = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, unknown> = {
      types: "public_channel,private_channel",
      limit: "200",
      exclude_archived: "true",
    };
    if (cursor) params.cursor = cursor;

    const response = await slack.apiCall<{
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string; is_private?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>("users.conversations", params);

    memberChannels = memberChannels.concat(response.channels ?? []);
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  log.info(
    {
      workspaceId,
      total: memberChannels.length,
      public: memberChannels.filter((ch) => !ch.is_private).length,
      private: memberChannels.filter((ch) => ch.is_private).length,
      names: memberChannels.map((ch) => `${ch.is_private ? "🔒" : "#"}${ch.name}`),
    },
    "users.conversations returned",
  );

  const existingRows = await db.getAllChannelsWithState(workspaceId);
  const existingMap = new Map(existingRows.map((r) => [r.channel_id, r]));

  const newChannels: Array<{ id: string; name: string; jobId: string | null }> = [];
  for (const ch of memberChannels) {
    const conversationType = ch.is_private ? "private_channel" as const : "public_channel" as const;
    const existing = existingMap.get(ch.id);
    if (!existing) {
      await db.upsertChannel(workspaceId, ch.id, "pending", ch.name, conversationType);
      const jobId = await enqueueBackfill(workspaceId, ch.id, "sync");
      newChannels.push({ id: ch.id, name: ch.name, jobId });
    } else if (existing.conversation_type !== conversationType) {
      // Fix stale conversation_type (e.g. channels added before migration 007)
      await db.upsertChannel(workspaceId, ch.id, existing.status, ch.name, conversationType);
      log.info({ channelId: ch.id, name: ch.name, old: existing.conversation_type, new: conversationType }, "Fixed conversation_type");
    }
  }

  lastDiscoveryAt.set(workspaceId, Date.now());
  pruneDiscoveryCooldowns();
  log.info({ workspaceId, discovered: memberChannels.length, newlyTracked: newChannels.length }, "Channel discovery complete");

  return {
    discovered: memberChannels.length,
    totalVisible: memberChannels.length,
    alreadyTracked: existingMap.size,
    newlyTracked: newChannels.length,
    channels: newChannels,
  };
}
