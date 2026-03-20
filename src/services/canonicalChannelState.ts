import * as db from "../db/queries.js";
import { resolveChannelMode } from "./channelMode.js";
import { buildChannelRiskState } from "./channelRisk.js";
import type {
  ChannelHealthCountsRow,
  ChannelRow,
  ChannelStateRow,
  FollowUpRuleRow,
} from "../types/database.js";

function parseCount(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface CanonicalStateOptions {
  channel?: ChannelRow | null;
  rule?: FollowUpRuleRow | null;
  healthCountsRow?: ChannelHealthCountsRow | null;
  channelState?: ChannelStateRow | null;
}

export async function resolveCanonicalChannelState(
  workspaceId: string,
  channelId: string,
  options: CanonicalStateOptions = {},
) {
  const [channel, rule, healthCountsRow, channelState] = await Promise.all([
    options.channel !== undefined
      ? Promise.resolve(options.channel)
      : db.getChannel(workspaceId, channelId),
    options.rule !== undefined
      ? Promise.resolve(options.rule)
      : db.getFollowUpRule(workspaceId, channelId),
    options.healthCountsRow !== undefined
      ? Promise.resolve(options.healthCountsRow)
      : db.getChannelHealthCounts(workspaceId, channelId).then(
          (rows) => rows[0] ?? null,
        ),
    options.channelState !== undefined
      ? Promise.resolve(options.channelState)
      : db.getChannelState(workspaceId, channelId),
  ]);

  const totalWindowMessages = parseCount(healthCountsRow?.total_message_count);
  const automationIncidentCount = parseCount(
    healthCountsRow?.automation_incident_count,
  );
  const automationSignalRatio =
    totalWindowMessages > 0 ? automationIncidentCount / totalWindowMessages : 0;

  const channelMode = resolveChannelMode({
    channelName: channel?.name ?? channelId,
    conversationType:
      rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
    channelModeOverride: rule?.channel_mode_override,
    automationSignalRatio,
  });

  const riskState = buildChannelRiskState(healthCountsRow, {
    effectiveChannelMode: channelMode.effectiveChannelMode,
  });

  return {
    channel,
    rule,
    channelState,
    healthCountsRow,
    channelMode,
    riskState,
  };
}

export async function persistCanonicalChannelState(
  workspaceId: string,
  channelId: string,
  options: CanonicalStateOptions = {},
) {
  const resolved = await resolveCanonicalChannelState(
    workspaceId,
    channelId,
    options,
  );

  await db.upsertChannelState(workspaceId, channelId, {
    signal: resolved.riskState.signal,
    health: resolved.riskState.health,
    signal_confidence: resolved.riskState.signalConfidence,
    risk_drivers_json: resolved.riskState.riskDrivers,
    attention_summary_json: resolved.riskState.attentionSummary,
    message_disposition_counts_json: resolved.riskState.messageDispositionCounts,
    effective_channel_mode: resolved.channelMode.effectiveChannelMode,
  });

  return resolved;
}
