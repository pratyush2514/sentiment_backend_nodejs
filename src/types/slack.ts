export type SlackFile = {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  permalink?: string;
};

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
  app_id?: string;
  username?: string;
  files?: SlackFile[];
};

export type SlackMessageChangedEvent = {
  type: "message";
  subtype: "message_changed";
  channel?: string;
  hidden?: boolean;
  message?: SlackMessageEvent & {
    user?: string;
    ts?: string;
    thread_ts?: string;
    edited?: {
      user?: string;
      ts?: string;
    };
  };
  previous_message?: SlackMessageEvent & {
    user?: string;
    ts?: string;
    thread_ts?: string;
  };
  event_ts?: string;
};

export type SlackMessageDeletedEvent = {
  type: "message";
  subtype: "message_deleted";
  channel?: string;
  deleted_ts?: string;
  previous_message?: SlackMessageEvent & {
    user?: string;
    ts?: string;
    thread_ts?: string;
  };
  event_ts?: string;
};

export type SlackMemberJoinedChannelEvent = {
  type: "member_joined_channel";
  user?: string;
  channel?: string;
};

export type SlackMemberLeftChannelEvent = {
  type: "member_left_channel";
  user?: string;
  channel?: string;
};

export type SlackReactionAddedEvent = {
  type: "reaction_added";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  event_ts?: string;
};

export type SlackReactionRemovedEvent = {
  type: "reaction_removed";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  event_ts?: string;
};

export type SlackEvent =
  | SlackMessageEvent
  | SlackMessageChangedEvent
  | SlackMessageDeletedEvent
  | SlackMemberJoinedChannelEvent
  | SlackMemberLeftChannelEvent
  | SlackReactionAddedEvent
  | SlackReactionRemovedEvent
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
  app_id?: string;
  username?: string;
  files?: SlackFile[];
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
  email?: string;
};

export type SlackUsersInfoResponse = SlackApiResponseBase & {
  user?: {
    id?: string;
    profile?: SlackUserProfile;
    deleted?: boolean;
    is_bot?: boolean;
    is_admin?: boolean;
    is_owner?: boolean;
  };
};

export type SlackConversationInfoResponse = SlackApiResponseBase & {
  channel?: {
    id?: string;
    name?: string;
    is_archived?: boolean;
    is_member?: boolean;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  };
};

export type SlackPostMessageResponse = SlackApiResponseBase & {
  channel?: string;
  ts?: string;
  message?: {
    text?: string;
  };
};

export type SlackPermalinkResponse = SlackApiResponseBase & {
  permalink?: string;
};

export type SlackConversationsOpenResponse = SlackApiResponseBase & {
  channel?: { id?: string };
};

export type SlackChatDeleteResponse = SlackApiResponseBase & {
  channel?: string;
  ts?: string;
};

export type SlackConversationsMembersResponse = SlackApiResponseBase & {
  members?: string[];
  response_metadata?: { next_cursor?: string };
};

type MessageAcceptanceOptions = {
  allowAutomatedMessages?: boolean;
};

function hasSupportedSlackMessageSubtype(subtype: unknown): boolean {
  return typeof subtype !== "string" || subtype === "file_share";
}

function hasProcessableMessageBody(raw: {
  text?: unknown;
  files?: unknown;
}): boolean {
  const hasText = typeof raw.text === "string" && raw.text.trim().length > 0;
  const hasFiles = Array.isArray(raw.files) && raw.files.length > 0;
  return hasText || hasFiles;
}

export function isIngestibleHistoryMessage(
  message: SlackHistoryMessage,
  options: MessageAcceptanceOptions = {},
): message is SlackHistoryMessage & {
  ts: string;
  user: string;
} {
  if (!hasProcessableMessageBody(message)) return false;
  if (typeof message.ts !== "string") return false;
  if (typeof message.user !== "string" || message.user.length === 0) return false;
  if (!hasSupportedSlackMessageSubtype(message.subtype)) return false;
  if (!options.allowAutomatedMessages && message.bot_id) return false;

  return true;
}

export function isHumanMessage(
  message: SlackHistoryMessage,
): message is SlackHistoryMessage & {
  ts: string;
  user: string;
} {
  return isIngestibleHistoryMessage(message, { allowAutomatedMessages: false });
}

export function isCandidateMessageEvent(
  event: SlackEvent,
): event is SlackMessageEvent &
  Required<Pick<SlackMessageEvent, "user" | "channel" | "ts">> {
  const raw = event as Record<string, unknown>;

  return (
    raw.type === "message" &&
    hasProcessableMessageBody(raw) &&
    typeof raw.user === "string" &&
    (raw.user as string).length > 0 &&
    typeof raw.channel === "string" &&
    (raw.channel as string).length > 0 &&
    typeof raw.ts === "string" &&
    (raw.ts as string).length > 0 &&
    hasSupportedSlackMessageSubtype(raw.subtype)
  );
}

export function isProcessableMessageEvent(
  event: SlackEvent,
  options: MessageAcceptanceOptions = {},
): event is SlackMessageEvent &
  Required<Pick<SlackMessageEvent, "user" | "channel" | "ts">> {
  const raw = event as Record<string, unknown>;

  return (
    isCandidateMessageEvent(event) &&
    (options.allowAutomatedMessages || !raw.bot_id)
  );
}

export function isProcessableHumanMessageEvent(
  event: SlackEvent,
): event is SlackMessageEvent &
  Required<Pick<SlackMessageEvent, "user" | "channel" | "ts">> {
  return isProcessableMessageEvent(event, { allowAutomatedMessages: false });
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

export function isBotLeaveEvent(
  event: SlackEvent,
  botUserId: string,
): event is SlackMemberLeftChannelEvent & {
  user: string;
  channel: string;
} {
  const raw = event as Record<string, unknown>;
  return (
    raw.type === "member_left_channel" &&
    typeof raw.user === "string" &&
    raw.user === botUserId &&
    typeof raw.channel === "string" &&
    (raw.channel as string).length > 0
  );
}

export function isReactionAddedEvent(
  event: SlackEvent,
): event is SlackReactionAddedEvent & {
  user: string;
  reaction: string;
  item: { type: "message"; channel: string; ts: string };
} {
  const raw = event as Record<string, unknown>;
  if (raw.type !== "reaction_added") return false;
  const item = raw.item as Record<string, unknown> | undefined;
  return (
    typeof raw.user === "string" &&
    typeof raw.reaction === "string" &&
    item?.type === "message" &&
    typeof item?.channel === "string" &&
    typeof item?.ts === "string"
  );
}

export function isReactionRemovedEvent(
  event: SlackEvent,
): event is SlackReactionRemovedEvent & {
  user: string;
  reaction: string;
  item: { type: "message"; channel: string; ts: string };
} {
  const raw = event as Record<string, unknown>;
  if (raw.type !== "reaction_removed") return false;
  const item = raw.item as Record<string, unknown> | undefined;
  return (
    typeof raw.user === "string" &&
    typeof raw.reaction === "string" &&
    item?.type === "message" &&
    typeof item?.channel === "string" &&
    typeof item?.ts === "string"
  );
}

export function isMessageChangedEvent(
  event: SlackEvent,
): event is SlackMessageChangedEvent & {
  channel: string;
  message: Required<Pick<SlackMessageEvent, "user" | "ts">> & SlackMessageEvent;
} {
  const raw = event as Record<string, unknown>;
  const message = raw.message as Record<string, unknown> | undefined;
  return (
    raw.type === "message" &&
    raw.subtype === "message_changed" &&
    typeof raw.channel === "string" &&
    typeof message?.user === "string" &&
    typeof message?.ts === "string" &&
    !message?.bot_id
  );
}

export function isMessageDeletedEvent(
  event: SlackEvent,
): event is SlackMessageDeletedEvent & {
  channel: string;
  deleted_ts: string;
} {
  const raw = event as Record<string, unknown>;
  return (
    raw.type === "message" &&
    raw.subtype === "message_deleted" &&
    typeof raw.channel === "string" &&
    typeof raw.deleted_ts === "string"
  );
}
