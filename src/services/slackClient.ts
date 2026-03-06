import { config } from "../config.js";
import { SLACK_MAX_RETRIES, SLACK_JITTER_MS } from "../constants.js";
import { logger } from "../utils/logger.js";
import type {
  SlackApiResponseBase,
  SlackHistoryResponse,
  SlackAuthTestResponse,
  SlackUsersInfoResponse,
} from "../types/slack.js";

const log = logger.child({ service: "slackClient" });

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Some Slack methods (e.g. conversations.replies) reject POST JSON body
// and require GET with query params instead.
const GET_METHODS = new Set([
  "conversations.replies",
  "users.info",
]);

export async function slackApiCall<T extends SlackApiResponseBase>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!config.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured.");
  }

  const useGet = GET_METHODS.has(method);

  let attempt = 0;
  while (attempt < SLACK_MAX_RETRIES) {
    attempt += 1;

    let response: Response;

    if (useGet) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) {
          qs.set(key, String(value));
        }
      }
      response = await fetch(`https://slack.com/api/${method}?${qs.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`,
        },
      });
    } else {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    }

    if (response.status === 429) {
      const retrySeconds = Number(response.headers.get("retry-after") ?? "1");
      const jitterMs = Math.floor(Math.random() * SLACK_JITTER_MS);
      log.warn({ method, retrySeconds, attempt }, "Slack 429 rate limited");
      await sleep(retrySeconds * 1000 + jitterMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Slack API ${method} failed with HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as T;
    if (!data.ok) {
      const errorDetail = (data as Record<string, unknown>).response_metadata;
      log.warn(
        { method, error: data.error, errorDetail, params: Object.keys(body) },
        "Slack API returned error",
      );
      throw new Error(
        `Slack API ${method} error: ${data.error ?? "unknown_error"}`,
      );
    }

    return data;
  }

  throw new Error(`Slack API ${method} failed after retries.`);
}

export async function fetchChannelHistory(
  channelId: string,
  oldest: string,
  cursor?: string,
): Promise<SlackHistoryResponse> {
  const params: Record<string, unknown> = {
    channel: channelId,
    oldest,
    limit: config.SLACK_PAGE_SIZE,
    inclusive: true,
  };
  if (cursor) params.cursor = cursor;
  return slackApiCall<SlackHistoryResponse>("conversations.history", params);
}

export async function fetchThreadReplies(
  channelId: string,
  threadTs: string,
  cursor?: string,
): Promise<SlackHistoryResponse> {
  const params: Record<string, unknown> = {
    channel: channelId,
    ts: threadTs,
    limit: config.SLACK_PAGE_SIZE,
  };
  if (cursor) params.cursor = cursor;
  return slackApiCall<SlackHistoryResponse>("conversations.replies", params);
}

export async function fetchUserProfile(
  userId: string,
): Promise<SlackUsersInfoResponse> {
  return slackApiCall<SlackUsersInfoResponse>("users.info", {
    user: userId,
  });
}

let _resolvedBotUserId: string | null = null;

export async function resolveBotUserId(): Promise<string> {
  if (_resolvedBotUserId) return _resolvedBotUserId;

  // Prefer env var
  if (config.SLACK_BOT_USER_ID) {
    _resolvedBotUserId = config.SLACK_BOT_USER_ID;
    return _resolvedBotUserId;
  }

  // Auto-detect via auth.test
  if (config.SLACK_BOT_TOKEN) {
    try {
      const auth = await slackApiCall<SlackAuthTestResponse>("auth.test", {});
      if (auth.user_id) {
        _resolvedBotUserId = auth.user_id;
        log.info({ botUserId: auth.user_id }, "Resolved bot user ID via auth.test");
        return _resolvedBotUserId;
      }
    } catch (err) {
      log.warn({ err }, "Failed to resolve bot user ID via auth.test");
    }
  }

  return "";
}

export function getBotUserId(): string {
  return _resolvedBotUserId ?? config.SLACK_BOT_USER_ID;
}
