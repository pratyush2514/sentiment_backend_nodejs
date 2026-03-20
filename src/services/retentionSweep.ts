import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "retentionSweep" });

let timer: NodeJS.Timeout | null = null;

export async function runRetentionSweep(): Promise<void> {
  try {
    const messagesResult = await pool.query(
      `DELETE FROM messages WHERE created_at < NOW() - make_interval(days => $1)`,
      [config.MESSAGE_RETENTION_DAYS ?? 90],
    );
    const messagesDeleted = messagesResult.rowCount ?? 0;

    const analyticsResult = await pool.query(
      `DELETE FROM message_analytics WHERE created_at < NOW() - make_interval(days => $1)`,
      [config.ANALYTICS_RETENTION_DAYS ?? 180],
    );
    const analyticsDeleted = analyticsResult.rowCount ?? 0;

    const slackEventsResult = await pool.query(
      `DELETE FROM slack_events WHERE received_at < NOW() - make_interval(days => $1)`,
      [7],
    );
    const slackEventsDeleted = slackEventsResult.rowCount ?? 0;

    log.info(
      {
        messagesDeleted,
        analyticsDeleted,
        slackEventsDeleted,
      },
      "Retention sweep completed",
    );
  } catch (err) {
    log.error({ err }, "Retention sweep failed");
  }
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function startRetentionSchedule(): NodeJS.Timeout {
  if (timer) {
    clearInterval(timer);
  }

  const run = () => {
    runRetentionSweep().catch((err) => {
      log.error({ err }, "Retention sweep failed (unhandled)");
    });
  };

  timer = setInterval(run, TWENTY_FOUR_HOURS_MS);
  timer.unref();
  run();

  return timer;
}

export function stopRetentionSchedule(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
