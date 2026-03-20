import { config } from "../config.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { syncChannelMemberList } from "./backfill.js";

const log = logger.child({ service: "channelMemberSync" });

let timer: NodeJS.Timeout | null = null;
let initialDelayTimer: NodeJS.Timeout | null = null;

async function runSync(): Promise<void> {
  const readyChannels = await db.getReadyChannels();

  if (readyChannels.length === 0) return;

  log.info(
    { count: readyChannels.length },
    "Starting periodic channel member sync",
  );

  for (const channel of readyChannels) {
    try {
      await syncChannelMemberList(channel.workspace_id, channel.channel_id);
    } catch (err) {
      log.warn(
        { channelId: channel.channel_id, err },
        "Channel member sync failed",
      );
    }
  }
  log.info(
    { count: readyChannels.length },
    "Periodic channel member sync complete",
  );
}

export function startChannelMemberSync(): void {
  if (timer) return;

  const run = () => {
    runSync().catch((err) => {
      log.error({ err }, "Channel member sync sweep failed");
    });
  };

  timer = setInterval(run, config.CHANNEL_MEMBER_SYNC_INTERVAL_MS);
  timer.unref();

  // Run first sync after a short delay to avoid contending with startup
  initialDelayTimer = setTimeout(run, 30_000);
}

export function stopChannelMemberSync(): void {
  if (initialDelayTimer) {
    clearTimeout(initialDelayTimer);
    initialDelayTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
