import { config } from "../config.js";
import { SLACK_MAX_RETRIES, SLACK_JITTER_MS } from "../constants.js";
import { logger } from "../utils/logger.js";
import type {
  SlackApiResponseBase,
  SlackHistoryResponse,
  SlackAuthTestResponse,
  SlackConversationInfoResponse,
  SlackPermalinkResponse,
  SlackPostMessageResponse,
  SlackUsersInfoResponse,
  SlackConversationsMembersResponse,
  SlackConversationsOpenResponse,
  SlackChatDeleteResponse,
} from "../types/slack.js";

const log = logger.child({ service: "slackClient" });

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    message: string,
    public readonly status: number | null,
    public readonly slackError: string | null,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export function isSlackAuthError(error: unknown): error is SlackApiError {
  if (!(error instanceof SlackApiError)) {
    return false;
  }

  return (
    error.status === 401 ||
    error.status === 403 ||
    error.slackError === "invalid_auth" ||
    error.slackError === "token_revoked" ||
    error.slackError === "account_inactive" ||
    error.slackError === "not_authed" ||
    error.slackError === "token_expired"
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Some Slack methods (e.g. conversations.replies) reject POST JSON body
// and require GET with query params instead.
const GET_METHODS = new Set([
  "conversations.replies",
  "conversations.info",
  "conversations.list",
  "users.info",
  "users.conversations",
  "chat.getPermalink",
  "conversations.members",
]);

// ─── Workspace-scoped Slack client ──────────────────────────────────────────

export class SlackClient {
  private _botUserId: string | null = null;
  private _token: string;

  constructor(
    token: string,
    private readonly options?: {
      onAuthFailure?: () => Promise<{ token: string; botUserId?: string | null }>;
    },
  ) {
    if (!token) {
      throw new Error("SlackClient requires a non-empty bot token.");
    }
    this._token = token;
  }

  async apiCall<T extends SlackApiResponseBase>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const useGet = GET_METHODS.has(method);

    let attempt = 0;
    let authRetryUsed = false;
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
            Authorization: `Bearer ${this._token}`,
          },
        });
      } else {
        response = await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._token}`,
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
        const httpError = new SlackApiError(
          method,
          `Slack API ${method} failed with HTTP ${response.status}`,
          response.status,
          null,
        );
        if (!authRetryUsed && this.options?.onAuthFailure && isSlackAuthError(httpError)) {
          authRetryUsed = true;
          const refreshed = await this.options.onAuthFailure();
          this._token = refreshed.token;
          if (refreshed.botUserId) {
            this._botUserId = refreshed.botUserId;
          }
          continue;
        }
        throw httpError;
      }

      const data = (await response.json()) as T;
      if (!data.ok) {
        const errorDetail = (data as Record<string, unknown>).response_metadata;
        log.warn(
          { method, error: data.error, errorDetail, params: Object.keys(body) },
          "Slack API returned error",
        );
        const slackError = new SlackApiError(
          method,
          `Slack API ${method} error: ${data.error ?? "unknown_error"}`,
          response.status,
          data.error ?? null,
        );
        if (!authRetryUsed && this.options?.onAuthFailure && isSlackAuthError(slackError)) {
          authRetryUsed = true;
          const refreshed = await this.options.onAuthFailure();
          this._token = refreshed.token;
          if (refreshed.botUserId) {
            this._botUserId = refreshed.botUserId;
          }
          continue;
        }
        throw slackError;
      }

      return data;
    }

    throw new Error(`Slack API ${method} failed after retries.`);
  }

  async fetchChannelHistory(
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
    return this.apiCall<SlackHistoryResponse>("conversations.history", params);
  }

  async fetchThreadReplies(
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
    return this.apiCall<SlackHistoryResponse>("conversations.replies", params);
  }

  async fetchUserProfile(
    userId: string,
  ): Promise<SlackUsersInfoResponse> {
    return this.apiCall<SlackUsersInfoResponse>("users.info", {
      user: userId,
    });
  }

  async fetchChannelMembers(
    channelId: string,
    cursor?: string,
  ): Promise<SlackConversationsMembersResponse> {
    const params: Record<string, unknown> = {
      channel: channelId,
      limit: 200,
    };
    if (cursor) params.cursor = cursor;
    return this.apiCall<SlackConversationsMembersResponse>("conversations.members", params);
  }

  async fetchChannelInfo(
    channelId: string,
  ): Promise<SlackConversationInfoResponse> {
    return this.apiCall<SlackConversationInfoResponse>("conversations.info", {
      channel: channelId,
    });
  }

  async fetchMessagePermalink(
    channelId: string,
    messageTs: string,
  ): Promise<string | null> {
    const response = await this.apiCall<SlackPermalinkResponse>("chat.getPermalink", {
      channel: channelId,
      message_ts: messageTs,
    });
    return response.permalink ?? null;
  }

  async postSlackMessage(input: {
    channelId: string;
    text: string;
    threadTs?: string | null;
    blocks?: unknown[];
  }): Promise<{ channelId: string; ts: string | null }> {
    const body: Record<string, unknown> = {
      channel: input.channelId,
      text: input.text,
      thread_ts: input.threadTs ?? undefined,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (input.blocks && input.blocks.length > 0) {
      body.blocks = input.blocks;
    }
    const response = await this.apiCall<SlackPostMessageResponse>("chat.postMessage", body);

    return {
      channelId: response.channel ?? input.channelId,
      ts: response.ts ?? null,
    };
  }

  /**
   * Open a DM channel with a user. Returns the DM channel ID.
   */
  async openDM(userId: string): Promise<string> {
    const response = await this.apiCall<SlackConversationsOpenResponse>("conversations.open", {
      users: userId,
      return_im: true,
    });
    const dmChannelId = response.channel?.id;
    if (!dmChannelId) {
      throw new Error(`Failed to open DM channel with user ${userId}`);
    }
    return dmChannelId;
  }

  /**
   * Delete a message sent by the bot.
   */
  async deleteMessage(channelId: string, ts: string): Promise<void> {
    await this.apiCall<SlackChatDeleteResponse>("chat.delete", {
      channel: channelId,
      ts,
    });
  }

  async resolveBotUserId(): Promise<string> {
    if (this._botUserId) return this._botUserId;

    try {
      const auth = await this.apiCall<SlackAuthTestResponse>("auth.test", {});
      if (auth.user_id) {
        this._botUserId = auth.user_id;
        log.info({ botUserId: auth.user_id }, "Resolved bot user ID via auth.test");
        return this._botUserId;
      }
    } catch (err) {
      log.warn({ err }, "Failed to resolve bot user ID via auth.test");
    }

    return "";
  }

  getBotUserId(): string {
    return this._botUserId ?? "";
  }
}

// ─── Global client for startup bot-identity resolution ──────────────────────
// Only used at startup when SLACK_BOT_TOKEN is set (dev/single-workspace mode).
// All runtime code should use getSlackClient(workspaceId) from slackClientFactory.ts.

let _globalClient: SlackClient | null = null;

export async function resolveBotUserId(): Promise<string> {
  if (!config.SLACK_BOT_TOKEN) {
    if (config.SLACK_BOT_USER_ID) return config.SLACK_BOT_USER_ID;
    return "";
  }
  if (!_globalClient) {
    _globalClient = new SlackClient(config.SLACK_BOT_TOKEN);
  }
  return _globalClient.resolveBotUserId();
}
