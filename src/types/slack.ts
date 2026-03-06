export type SlackUrlVerificationPayload = {
  type: "url_verification";
  challenge: string;
};

export type SlackMessageEvent = {
  type: "message";
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
};

export type SlackMemberJoinedChannelEvent = {
  type: "member_joined_channel";
  user?: string;
  channel?: string;
};

export type SlackEvent =
  | SlackMessageEvent
  | SlackMemberJoinedChannelEvent
  | { type: string };

export type SlackEventCallbackPayload = {
  type: "event_callback";
  event_id?: string;
  team_id?: string;
  event: SlackEvent;
};

export type SlackPayload =
  | SlackUrlVerificationPayload
  | SlackEventCallbackPayload
  | { type?: string; [key: string]: unknown };

export type SlackHistoryMessage = {
  ts?: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  bot_id?: string;
};

export type SlackApiResponseBase = {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
};

export type SlackHistoryResponse = SlackApiResponseBase & {
  messages?: SlackHistoryMessage[];
  has_more?: boolean;
};

export type SlackAuthTestResponse = SlackApiResponseBase & {
  user_id?: string;
  bot_id?: string;
  team_id?: string;
};

export type SlackUserProfile = {
  display_name?: string;
  real_name?: string;
  image_48?: string;
};

export type SlackUsersInfoResponse = SlackApiResponseBase & {
  user?: {
    id?: string;
    profile?: SlackUserProfile;
    deleted?: boolean;
    is_bot?: boolean;
  };
};

export function isHumanMessage(
  message: SlackHistoryMessage,
): message is SlackHistoryMessage & {
  ts: string;
  text: string;
  user: string;
} {
  return (
    typeof message.ts === "string" &&
    typeof message.text === "string" &&
    message.text.trim().length > 0 &&
    typeof message.user === "string" &&
    message.user.length > 0 &&
    !message.subtype &&
    !message.bot_id
  );
}

export function isProcessableHumanMessageEvent(
  event: SlackEvent,
): event is SlackMessageEvent &
  Required<Pick<SlackMessageEvent, "text" | "user" | "channel" | "ts">> {
  const raw = event as Record<string, unknown>;
  return (
    raw.type === "message" &&
    typeof raw.text === "string" &&
    (raw.text as string).length > 0 &&
    typeof raw.user === "string" &&
    (raw.user as string).length > 0 &&
    typeof raw.channel === "string" &&
    (raw.channel as string).length > 0 &&
    typeof raw.ts === "string" &&
    (raw.ts as string).length > 0 &&
    !raw.subtype &&
    !raw.bot_id
  );
}

export function isBotJoinEvent(
  event: SlackEvent,
  botUserId: string,
): event is SlackMemberJoinedChannelEvent & {
  user: string;
  channel: string;
} {
  const raw = event as Record<string, unknown>;
  return (
    raw.type === "member_joined_channel" &&
    typeof raw.user === "string" &&
    raw.user === botUserId &&
    typeof raw.channel === "string" &&
    (raw.channel as string).length > 0
  );
}
