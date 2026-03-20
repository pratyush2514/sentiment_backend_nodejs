import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { refreshExpiringWorkspaceBotTokens } from "./slackTokenManager.js";

const log = logger.child({ service: "tokenRotationSchedule" });

let timer: NodeJS.Timeout | null = null;

export async function runTokenRotationSweep(): Promise<void> {
  const result = await refreshExpiringWorkspaceBotTokens();
  if (result.attempted > 0) {
    log.info(result, "Slack bot token refresh sweep completed");
  } else {
    log.debug("No expiring Slack bot tokens to refresh");
  }
}

export function startTokenRotationSchedule(): NodeJS.Timeout {
  if (timer) {
    clearInterval(timer);
  }

  const run = () => {
    runTokenRotationSweep().catch((err) => {
      log.error({ err }, "Slack bot token refresh sweep failed");
    });
  };

  timer = setInterval(run, config.SLACK_TOKEN_REFRESH_SWEEP_MS);
  timer.unref();
  run();

  return timer;
}

export function stopTokenRotationSchedule(): void {
  if (!timer) {
    return;
  }

  clearInterval(timer);
  timer = null;
}
