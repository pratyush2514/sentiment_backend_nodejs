import * as db from "../db/queries.js";
import { resolveChannelMode } from "./channelMode.js";
import { classifyMessageTriage } from "./messageTriage.js";
import {
  buildFileContext,
  buildLinkContext,
  extractLinks,
  normalizeText,
} from "./textNormalizer.js";
import type { LinkMetadata } from "./textNormalizer.js";
import type {
  ChannelHealthCountsRow,
  ChannelRow,
  FollowUpRuleRow,
  MessageRow,
  OriginType,
  ChannelMode,
} from "../types/database.js";

interface PersistCanonicalMessageSignalInput {
  workspaceId: string;
  channelId: string;
  message: MessageRow;
  channel?: ChannelRow | null;
  rule?: FollowUpRuleRow | null;
  channelMode?: ChannelMode | null;
  originType?: OriginType | null;
}

interface HydrateChannelCanonicalSignalsInput {
  workspaceId: string;
  channelId: string;
  channel?: ChannelRow | null;
  rule?: FollowUpRuleRow | null;
  windowDays?: number;
}

export function shouldRepairMissingCanonicalSignals(
  healthCounts?: ChannelHealthCountsRow | null,
): boolean {
  if (!healthCounts) {
    return false;
  }

  const totalMessageCount = Number.parseInt(
    String(healthCounts.total_message_count ?? "0"),
    10,
  );
  const skippedMessageCount = Number.parseInt(
    String(healthCounts.skipped_message_count ?? "0"),
    10,
  );
  const totalAnalyzed = Number.parseInt(
    String(healthCounts.total_analyzed_count ?? "0"),
    10,
  );
  const canonicalSignalCoverage =
    Number.parseInt(String(healthCounts.automation_incident_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.human_risk_signal_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.request_signal_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.decision_signal_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.resolution_signal_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.context_only_message_count ?? "0"), 10) +
    Number.parseInt(String(healthCounts.ignored_message_count ?? "0"), 10);

  return (
    totalMessageCount > 0 &&
    skippedMessageCount > 0 &&
    totalAnalyzed === 0 &&
    canonicalSignalCoverage === 0
  );
}

function deriveOriginType(message: MessageRow): OriginType {
  if (message.bot_id) {
    return "bot";
  }
  if (message.subtype) {
    return "system";
  }
  return "human";
}

function deriveEffectiveChannelMode(
  message: MessageRow,
  channel?: ChannelRow | null,
  rule?: FollowUpRuleRow | null,
): ChannelMode {
  const isAutomatedMessage = Boolean(message.bot_id);
  return resolveChannelMode({
    channelName: channel?.name ?? message.channel_id,
    conversationType:
      rule?.conversation_type ?? channel?.conversation_type ?? "public_channel",
    channelModeOverride: rule?.channel_mode_override,
    botMessageRatio: isAutomatedMessage ? 1 : 0,
    automationSignalRatio: isAutomatedMessage ? 0.75 : 0,
  }).effectiveChannelMode;
}

function toLinkMetadata(
  links?: MessageRow["links_json"],
): LinkMetadata[] | null {
  if (!links || links.length === 0) {
    return null;
  }

  return links.map((link) => ({
    url: link.url,
    domain: link.domain,
    label: link.label,
    linkType:
      link.linkType === "pr" ||
      link.linkType === "issue" ||
      link.linkType === "repo" ||
      link.linkType === "doc" ||
      link.linkType === "design" ||
      link.linkType === "task" ||
      link.linkType === "link"
        ? link.linkType
        : "link",
  }));
}

export async function persistCanonicalMessageSignal(
  input: PersistCanonicalMessageSignalInput,
): Promise<void> {
  const { workspaceId, channelId, message } = input;
  const links =
    message.links_json && message.links_json.length > 0
      ? toLinkMetadata(message.links_json) ?? []
      : extractLinks(message.text ?? "");
  const normalizedText =
    message.normalized_text?.trim() ||
    (
      normalizeText(message.text ?? "") +
      buildFileContext(message.files_json) +
      buildLinkContext(links.length > 0 ? links : null)
    ).trim();

  if (normalizedText !== (message.normalized_text ?? "")) {
    await db.updateNormalizedText(workspaceId, channelId, message.ts, normalizedText);
  }

  const originType = input.originType ?? deriveOriginType(message);
  const channelMode =
    input.channelMode ??
    deriveEffectiveChannelMode(message, input.channel, input.rule);
  const triage = classifyMessageTriage({
    text: message.text ?? "",
    normalizedText,
    threadTs: message.thread_ts ?? null,
    channelMode,
    originType,
    channelName: input.channel?.name ?? channelId,
  });

  await db.upsertMessageTriage({
    workspaceId,
    channelId,
    messageTs: message.ts,
    candidateKind: triage.candidateKind,
    signalType: triage.signalType,
    severity: triage.severity,
    surfacePriority: triage.surfacePriority,
    candidateScore: triage.candidateScore,
    stateTransition: triage.stateTransition,
    stateImpact: triage.stateImpact,
    evidenceType: triage.evidenceType,
    channelMode: triage.channelMode,
    originType: triage.originType,
    confidence: triage.confidence,
    incidentFamily: triage.incidentFamily,
    reasonCodes: triage.reasonCodes,
    signals: triage.signals,
  });
}

export async function hydrateChannelCanonicalSignals(
  input: HydrateChannelCanonicalSignalsInput,
): Promise<{ hydratedCount: number; inspectedCount: number }> {
  const windowDays =
    input.windowDays ??
    (await db.getEffectiveAnalysisWindowDays(input.workspaceId, input.channelId));
  const messages = await db.getMessagesInWindow(
    input.workspaceId,
    input.channelId,
    windowDays,
    null,
    1000,
  );

  if (messages.length === 0) {
    return { hydratedCount: 0, inspectedCount: 0 };
  }

  const triageRows = await db.getMessageTriageBatch(
    input.workspaceId,
    input.channelId,
    messages.map((message) => message.ts),
  );
  const triageByTs = new Set(triageRows.map((row) => row.message_ts));

  let hydratedCount = 0;
  for (const message of messages) {
    if (triageByTs.has(message.ts)) {
      continue;
    }

    await persistCanonicalMessageSignal({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      message,
      channel: input.channel,
      rule: input.rule,
    });
    hydratedCount += 1;
  }

  return {
    hydratedCount,
    inspectedCount: messages.length,
  };
}

export async function reclassifyChannelCanonicalSignals(
  input: HydrateChannelCanonicalSignalsInput,
): Promise<{ reclassifiedCount: number; inspectedCount: number }> {
  const windowDays =
    input.windowDays ??
    (await db.getEffectiveAnalysisWindowDays(input.workspaceId, input.channelId));
  const messages = await db.getMessagesInWindow(
    input.workspaceId,
    input.channelId,
    windowDays,
    null,
    1000,
  );

  if (messages.length === 0) {
    return { reclassifiedCount: 0, inspectedCount: 0 };
  }

  for (const message of messages) {
    await persistCanonicalMessageSignal({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      message,
      channel: input.channel,
      rule: input.rule,
    });
  }

  return {
    reclassifiedCount: messages.length,
    inspectedCount: messages.length,
  };
}
