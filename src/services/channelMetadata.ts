import { logger } from "../utils/logger.js";
import { getSlackClient } from "./slackClientFactory.js";
import type { ConversationType } from "../types/database.js";
import type { SlackConversationInfoResponse } from "../types/slack.js";

const log = logger.child({ service: "channelMetadata" });

export interface ChannelMetadata {
  name: string | null;
  conversationType: ConversationType;
}

export function deriveConversationType(
  channel: SlackConversationInfoResponse["channel"] | null | undefined,
): ConversationType {
  return channel?.is_im
    ? "dm"
    : channel?.is_mpim
      ? "group_dm"
      : channel?.is_private
        ? "private_channel"
        : "public_channel";
}

export async function resolveChannelMetadata(
  workspaceId: string,
  channelId: string,
): Promise<ChannelMetadata | null> {
  try {
    const slack = await getSlackClient(workspaceId);
    const info = await slack.fetchChannelInfo(channelId);
    return {
      name: info.channel?.name?.trim() || null,
      conversationType: deriveConversationType(info.channel),
    };
  } catch (err) {
    log.warn({ channelId, err }, "Unable to resolve channel metadata from Slack");
    return null;
  }
}
