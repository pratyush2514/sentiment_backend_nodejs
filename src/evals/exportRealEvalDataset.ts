/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { pool, shutdown } from "../db/pool.js";
import {
  getActiveThreadsSinceTs,
  getAllChannelsWithState,
  getChannelClassification,
  getChannelHealthCounts,
  getChannelSummary,
  getChannelTruthDiagnostics,
  getMessagesInWindow,
  getRecentThreadInsights,
  getTopLevelMessagesEnriched,
  type ChannelSummaryData,
  type ChannelTruthDiagnostics,
} from "../db/queries.js";
import {
  buildChannelRiskState,
  type ChannelRiskEvidenceTier,
  type ChannelRiskHealth,
  type ChannelRiskSignal,
} from "../services/channelRisk.js";
import {
  getProductWindowPolicyPayload,
  getProductWindowStartTs,
  PRODUCT_WINDOW_POLICY,
} from "../services/windowPolicy.js";
import type {
  ChannelHealthCountsRow,
  ChannelOverviewRow,
  EnrichedMessageWithAnalyticsRow,
  MessageRow,
  ThreadInsightRow,
} from "../types/database.js";

interface CliOptions {
  workspaceId?: string;
  limit: number;
  outputPath?: string;
  channelIds: string[];
  includeNonReady: boolean;
  messageLimit: number;
  topLevelLimit: number;
  threadInsightLimit: number;
}

interface WorkspaceChoice {
  workspace_id: string;
  team_name: string | null;
}

interface RealEvalDatasetCase {
  caseId: string;
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  conversationType: string;
  channelStatus: string;
  lastEventAt: string | null;
  windowPolicy: ReturnType<typeof getProductWindowPolicyPayload>;
  currentSystemAssessment: {
    persisted: {
      signal: ChannelRiskSignal | null;
      health: ChannelRiskHealth | null;
      confidence: number | null;
      evidenceTier: ChannelRiskEvidenceTier | null;
      effectiveChannelMode: string | null;
      riskDrivers: unknown[] | null;
      attentionSummary: unknown | null;
      messageDispositionCounts: unknown | null;
      latestSummaryCompleteness: string | null;
      hasActiveDegradations: boolean;
      activeDegradationCount: number;
    };
    recomputedFromCounts: ReturnType<typeof buildChannelRiskState> | null;
    differsFromPersisted: boolean;
  };
  classification: {
    channelType: string | null;
    confidence: number | null;
    source: string | null;
    clientName: string | null;
    topics: string[];
    reasoning: string | null;
  };
  truthDiagnostics: {
    ingestReadiness: string;
    intelligenceReadiness: string;
    messageCounts: ChannelTruthDiagnostics["messageCounts"];
    summaryArtifact: ChannelTruthDiagnostics["summaryArtifact"];
    backfillRun: ChannelTruthDiagnostics["backfillRun"];
    activeDegradationEvents: ChannelTruthDiagnostics["activeDegradationEvents"];
  };
  summaryContext: {
    runningSummary: string;
    keyDecisions: string[];
    totalRollups: number;
    latestRollupAt: string | null;
    totalMessages: number;
    totalAnalyses: number;
    activeMessageCount: number;
    activeWindowDays: number;
    sentimentSnapshot: Record<string, unknown>;
  } | null;
  rawHealthCounts: Record<string, number> | null;
  activeThreads: Array<{
    threadTs: string;
    replyCount: number;
    lastActivity: string;
  }>;
  surfacedThreadInsights: Array<{
    threadTs: string;
    surfacePriority: string;
    threadState: string;
    emotionalTemperature: string;
    operationalRisk: string;
    primaryIssue: string;
    summary: string;
    openQuestions: string[];
    lastMeaningfulChangeTs: string | null;
  }>;
  topLevelMessages: Array<{
    ts: string;
    userId: string;
    displayName: string | null;
    realName: string | null;
    text: string;
    replyCount: number;
    analysisStatus: string;
    analysis: {
      eligibility: string | null;
      execution: string | null;
      quality: string | null;
      suppressionReason: string | null;
      dominantEmotion: string | null;
      interactionTone: string | null;
      escalationRisk: string | null;
      explanation: string | null;
      themes: string[];
      messageIntent: string | null;
      isActionable: boolean | null;
      isBlocking: boolean | null;
      urgencyLevel: string | null;
    };
    triage: {
      candidateKind: string | null;
      signalType: string | null;
      severity: string | null;
      stateImpact: string | null;
      evidenceType: string | null;
      surfacePriority: string | null;
      stateTransition: string | null;
      confidence: number | null;
      reasonCodes: string[];
    };
    followUp: {
      id: string | null;
      seriousness: string | null;
      summary: string | null;
      dueAt: string | null;
      repeatedAskCount: number | null;
    };
  }>;
  recentMessages: Array<{
    ts: string;
    threadTs: string | null;
    userId: string;
    text: string;
    source: string;
    analysisStatus: string;
    subtype: string | null;
  }>;
  humanReview: {
    expectedHealth: ChannelRiskHealth | null;
    expectedSignal: ChannelRiskSignal | null;
    shouldBeRed: boolean | null;
    summaryFairness:
      | "fair"
      | "mixed"
      | "overstated"
      | "understated"
      | "unsupported"
      | null;
    summaryAccuracyNotes: string | null;
    primaryUserFeeling: string | null;
    keyEvidence: string[];
    reviewer: string | null;
    reviewedAt: string | null;
    notes: string | null;
  };
}

interface RealEvalDataset {
  generatedAt: string;
  warning: string;
  workspace: {
    workspaceId: string;
    teamName: string | null;
  };
  windowPolicy: ReturnType<typeof getProductWindowPolicyPayload>;
  reviewRubric: {
    expectedHealthValues: ChannelRiskHealth[];
    expectedSignalValues: ChannelRiskSignal[];
    summaryFairnessValues: Array<
      "fair" | "mixed" | "overstated" | "understated" | "unsupported"
    >;
    shouldBeRedDefinition: string;
  };
  cases: RealEvalDatasetCase[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 20,
    channelIds: [],
    includeNonReady: false,
    messageLimit: 80,
    topLevelLimit: 40,
    threadInsightLimit: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--workspace":
      case "--workspace-id":
        options.workspaceId = next;
        index += 1;
        break;
      case "--limit":
        options.limit = clampInt(next, 1, 200, 20);
        index += 1;
        break;
      case "--channels":
      case "--channel-ids":
        options.channelIds = (next ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        index += 1;
        break;
      case "--output":
        options.outputPath = next;
        index += 1;
        break;
      case "--message-limit":
        options.messageLimit = clampInt(next, 10, 300, 80);
        index += 1;
        break;
      case "--top-level-limit":
        options.topLevelLimit = clampInt(next, 10, 200, 40);
        index += 1;
        break;
      case "--thread-insight-limit":
        options.threadInsightLimit = clampInt(next, 1, 20, 5);
        index += 1;
        break;
      case "--include-nonready":
        options.includeNonReady = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        break;
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`Export a real channel eval dataset from the live workspace DB.

Options:
  --workspace <workspaceId>        Active workspace id to export
  --channels <id1,id2>             Optional channel ids to include
  --limit <n>                      Max channels to export (default: 20)
  --message-limit <n>              Raw recent messages per case (default: 80)
  --top-level-limit <n>            Enriched top-level messages per case (default: 40)
  --thread-insight-limit <n>       Surfaced thread insights per case (default: 5)
  --include-nonready               Include non-ready channels too
  --output <path>                  JSON output path (CSV index written beside it)
`);
}

function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toInt(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildDefaultOutputPath(workspaceId: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return path.resolve(
    process.cwd(),
    "tmp/evals",
    `real-channel-eval-${workspaceId}-${stamp}.json`,
  );
}

function jsonPathToCsvPath(jsonPath: string): string {
  return jsonPath.endsWith(".json")
    ? jsonPath.replace(/\.json$/u, ".csv")
    : `${jsonPath}.csv`;
}

async function selectWorkspace(
  requestedWorkspaceId?: string,
): Promise<WorkspaceChoice> {
  const result = await pool.query<WorkspaceChoice & { install_status: string }>(
    `SELECT workspace_id, team_name, install_status
     FROM workspaces
     WHERE install_status = 'active'
     ORDER BY installed_at DESC NULLS LAST, created_at DESC`,
  );
  const active = result.rows;

  if (requestedWorkspaceId) {
    const match = active.find(
      (workspace) => workspace.workspace_id === requestedWorkspaceId,
    );
    if (!match) {
      throw new Error(
        `Workspace ${requestedWorkspaceId} was not found among active installs.`,
      );
    }
    return {
      workspace_id: match.workspace_id,
      team_name: match.team_name,
    };
  }

  if (active.length === 0) {
    throw new Error("No active workspaces found.");
  }

  if (active.length > 1) {
    const workspaces = active
      .map((workspace) => `${workspace.workspace_id} (${workspace.team_name ?? "unknown"})`)
      .join(", ");
    throw new Error(
      `Multiple active workspaces found. Re-run with --workspace. Active: ${workspaces}`,
    );
  }

  return {
    workspace_id: active[0].workspace_id,
    team_name: active[0].team_name,
  };
}

function parseHealthCounts(
  row: ChannelHealthCountsRow | null | undefined,
): Record<string, number> | null {
  if (!row) return null;

  return {
    analysisWindowDays: toInt(row.analysis_window_days),
    openAlertCount: toInt(row.open_alert_count),
    highSeverityAlertCount: toInt(row.high_severity_alert_count),
    automationIncidentCount: toInt(row.automation_incident_count),
    criticalAutomationIncidentCount: toInt(row.critical_automation_incident_count),
    automationIncident24hCount: toInt(row.automation_incident_24h_count),
    criticalAutomationIncident24hCount: toInt(row.critical_automation_incident_24h_count),
    humanRiskSignalCount: toInt(row.human_risk_signal_count),
    requestSignalCount: toInt(row.request_signal_count),
    decisionSignalCount: toInt(row.decision_signal_count),
    resolutionSignalCount: toInt(row.resolution_signal_count),
    flaggedMessageCount: toInt(row.flagged_message_count),
    highRiskMessageCount: toInt(row.high_risk_message_count),
    attentionThreadCount: toInt(row.attention_thread_count),
    blockedThreadCount: toInt(row.blocked_thread_count),
    escalatedThreadCount: toInt(row.escalated_thread_count),
    riskyThreadCount: toInt(row.risky_thread_count),
    totalMessageCount: toInt(row.total_message_count),
    skippedMessageCount: toInt(row.skipped_message_count),
    contextOnlyMessageCount: toInt(row.context_only_message_count),
    ignoredMessageCount: toInt(row.ignored_message_count),
    inflightMessageCount: toInt(row.inflight_message_count),
    totalAnalyzedCount: toInt(row.total_analyzed_count),
    angerCount: toInt(row.anger_count),
    disgustCount: toInt(row.disgust_count),
    fearCount: toInt(row.fear_count),
    joyCount: toInt(row.joy_count),
    neutralCount: toInt(row.neutral_count),
    sadnessCount: toInt(row.sadness_count),
    surpriseCount: toInt(row.surprise_count),
  };
}

function mapSummary(summary: ChannelSummaryData | null) {
  if (!summary) return null;

  return {
    runningSummary: summary.runningSummary,
    keyDecisions: summary.keyDecisions,
    totalRollups: summary.totalRollups,
    latestRollupAt: toIso(summary.latestRollupAt),
    totalMessages: summary.totalMessages,
    totalAnalyses: summary.totalAnalyses,
    activeMessageCount: summary.activeMessageCount,
    activeWindowDays: summary.activeWindowDays,
    sentimentSnapshot: summary.sentimentSnapshot,
  };
}

function mapRecentMessage(message: MessageRow) {
  return {
    ts: message.ts,
    threadTs: message.thread_ts,
    userId: message.user_id,
    text: message.text,
    source: message.source,
    analysisStatus: message.analysis_status,
    subtype: message.subtype,
  };
}

function mapTopLevelMessage(
  message: EnrichedMessageWithAnalyticsRow & { reply_count: number },
) {
  return {
    ts: message.ts,
    userId: message.user_id,
    displayName: message.display_name,
    realName: message.real_name,
    text: message.text,
    replyCount: message.reply_count,
    analysisStatus: message.analysis_status,
    analysis: {
      eligibility: message.analysis_eligibility,
      execution: message.analysis_execution,
      quality: message.analysis_quality,
      suppressionReason: message.suppression_reason,
      dominantEmotion: message.ma_dominant_emotion,
      interactionTone: message.ma_interaction_tone,
      escalationRisk: message.ma_escalation_risk,
      explanation: message.ma_explanation,
      themes: message.ma_themes ?? [],
      messageIntent: message.ma_message_intent,
      isActionable: message.ma_is_actionable,
      isBlocking: message.ma_is_blocking,
      urgencyLevel: message.ma_urgency_level,
    },
    triage: {
      candidateKind: message.mt_candidate_kind,
      signalType: message.mt_signal_type,
      severity: message.mt_severity,
      stateImpact: message.mt_state_impact,
      evidenceType: message.mt_evidence_type,
      surfacePriority: message.mt_surface_priority,
      stateTransition: message.mt_state_transition,
      confidence: message.mt_confidence,
      reasonCodes: message.mt_reason_codes ?? [],
    },
    followUp: {
      id: message.fu_id,
      seriousness: message.fu_seriousness,
      summary: message.fu_summary,
      dueAt: toIso(message.fu_due_at),
      repeatedAskCount: message.fu_repeated_ask_count,
    },
  };
}

function mapThreadInsight(insight: ThreadInsightRow) {
  return {
    threadTs: insight.thread_ts,
    surfacePriority: insight.surface_priority,
    threadState: insight.thread_state,
    emotionalTemperature: insight.emotional_temperature,
    operationalRisk: insight.operational_risk,
    primaryIssue: insight.primary_issue,
    summary: insight.summary,
    openQuestions: insight.open_questions_json,
    lastMeaningfulChangeTs: insight.last_meaningful_change_ts,
  };
}

function differsFromPersisted(
  overview: ChannelOverviewRow,
  recomputed: ReturnType<typeof buildChannelRiskState> | null,
): boolean {
  if (!recomputed) return false;

  const persistedConfidence =
    typeof overview.signal_confidence === "number"
      ? Number(overview.signal_confidence.toFixed(2))
      : null;
  const recomputedConfidence = Number(recomputed.signalConfidence.toFixed(2));

  return (
    overview.signal !== recomputed.signal ||
    overview.health !== recomputed.health ||
    persistedConfidence !== recomputedConfidence
  );
}

function escapeCsv(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(" | ")
        : String(value);
  return `"${raw.replaceAll(`"`, `""`)}"`;
}

function buildCsvIndex(dataset: RealEvalDataset): string {
  const headers = [
    "caseId",
    "channelId",
    "channelName",
    "channelStatus",
    "conversationType",
    "activeMessageCount",
    "totalImportedMessageCount",
    "persistedSignal",
    "persistedHealth",
    "persistedConfidence",
    "recomputedSignal",
    "recomputedHealth",
    "recomputedConfidence",
    "effectiveChannelMode",
    "classification",
    "classificationSource",
    "ingestReadiness",
    "intelligenceReadiness",
    "latestSummaryCompleteness",
    "activeDegradationCount",
    "riskDriverKeys",
    "attentionTitle",
    "summarySnippet",
    "expectedHealth",
    "expectedSignal",
    "shouldBeRed",
    "summaryFairness",
    "primaryUserFeeling",
    "notes",
  ];

  const rows = dataset.cases.map((entry) => {
    const riskDriverKeys = (
      (entry.currentSystemAssessment.persisted.riskDrivers as Array<{ key?: string }> | null) ??
      []
    ).map((driver) => driver.key ?? "");
    const summarySnippet =
      entry.summaryContext?.runningSummary.slice(0, 180).replace(/\s+/gu, " ") ?? "";

    return [
      entry.caseId,
      entry.channelId,
      entry.channelName ?? "",
      entry.channelStatus,
      entry.conversationType,
      entry.summaryContext?.activeMessageCount ?? 0,
      entry.summaryContext?.totalMessages ?? 0,
      entry.currentSystemAssessment.persisted.signal ?? "",
      entry.currentSystemAssessment.persisted.health ?? "",
      entry.currentSystemAssessment.persisted.confidence ?? "",
      entry.currentSystemAssessment.recomputedFromCounts?.signal ?? "",
      entry.currentSystemAssessment.recomputedFromCounts?.health ?? "",
      entry.currentSystemAssessment.recomputedFromCounts
        ? Number(
            entry.currentSystemAssessment.recomputedFromCounts.signalConfidence.toFixed(2),
          )
        : "",
      entry.currentSystemAssessment.persisted.effectiveChannelMode ?? "",
      entry.classification.channelType ?? "",
      entry.classification.source ?? "",
      entry.truthDiagnostics.ingestReadiness,
      entry.truthDiagnostics.intelligenceReadiness,
      entry.currentSystemAssessment.persisted.latestSummaryCompleteness ?? "",
      entry.currentSystemAssessment.persisted.activeDegradationCount,
      riskDriverKeys,
      (entry.currentSystemAssessment.persisted.attentionSummary as { title?: string } | null)
        ?.title ?? "",
      summarySnippet,
      "",
      "",
      "",
      "",
      "",
      "",
    ];
  });

  return [headers, ...rows]
    .map((row) => row.map((value) => escapeCsv(value)).join(","))
    .join("\n");
}

function buildCaseId(channel: ChannelOverviewRow, index: number): string {
  const safeName = (channel.name ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `${String(index + 1).padStart(2, "0")}-${safeName || "channel"}-${channel.channel_id}`;
}

async function buildDatasetCase(
  workspaceId: string,
  channel: ChannelOverviewRow,
  index: number,
  options: CliOptions,
  threadInsightsByChannel: Map<string, ThreadInsightRow[]>,
): Promise<RealEvalDatasetCase> {
  const activeWindowStartTs = getProductWindowStartTs("active");

  const [
    summary,
    diagnostics,
    healthCountsRows,
    classification,
    topLevelMessages,
    recentMessages,
    activeThreads,
  ] = await Promise.all([
    getChannelSummary(workspaceId, channel.channel_id, {
      windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
    }),
    getChannelTruthDiagnostics(workspaceId, channel.channel_id),
    getChannelHealthCounts(workspaceId, channel.channel_id, {
      windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
    }),
    getChannelClassification(workspaceId, channel.channel_id),
    getTopLevelMessagesEnriched(workspaceId, channel.channel_id, {
      limit: options.topLevelLimit,
      afterTs: activeWindowStartTs,
    }),
    getMessagesInWindow(
      workspaceId,
      channel.channel_id,
      PRODUCT_WINDOW_POLICY.activeWindowDays,
      null,
      options.messageLimit,
    ),
    activeWindowStartTs
      ? getActiveThreadsSinceTs(
          workspaceId,
          channel.channel_id,
          activeWindowStartTs,
          Math.max(10, options.threadInsightLimit * 2),
        )
      : Promise.resolve([]),
  ]);

  const healthRow = healthCountsRows[0] ?? null;
  const recomputed = healthRow
    ? buildChannelRiskState(healthRow, {
        effectiveChannelMode: channel.effective_channel_mode ?? "collaboration",
      })
    : null;
  const channelThreadInsights = (
    threadInsightsByChannel.get(channel.channel_id) ?? []
  ).slice(0, options.threadInsightLimit);

  return {
    caseId: buildCaseId(channel, index),
    workspaceId,
    channelId: channel.channel_id,
    channelName: channel.name,
    conversationType: channel.conversation_type,
    channelStatus: channel.status,
    lastEventAt: toIso(channel.last_event_at),
    windowPolicy: getProductWindowPolicyPayload(),
    currentSystemAssessment: {
      persisted: {
        signal: channel.signal,
        health: channel.health,
        confidence: channel.signal_confidence,
        evidenceTier: recomputed?.signalEvidenceTier ?? null,
        effectiveChannelMode: channel.effective_channel_mode ?? null,
        riskDrivers: channel.risk_drivers_json ?? null,
        attentionSummary: channel.attention_summary_json ?? null,
        messageDispositionCounts: channel.message_disposition_counts_json ?? null,
        latestSummaryCompleteness: channel.latest_summary_completeness ?? null,
        hasActiveDegradations: Boolean(channel.has_active_degradations),
        activeDegradationCount: toInt(channel.active_degradation_count),
      },
      recomputedFromCounts: recomputed,
      differsFromPersisted: differsFromPersisted(channel, recomputed),
    },
    classification: {
      channelType: classification?.channel_type ?? null,
      confidence: classification?.confidence ?? null,
      source: classification?.classification_source ?? null,
      clientName: classification?.client_name ?? null,
      topics: classification?.topics_json ?? [],
      reasoning: classification?.reasoning ?? null,
    },
    truthDiagnostics: {
      ingestReadiness: diagnostics.ingestReadiness,
      intelligenceReadiness: diagnostics.intelligenceReadiness,
      messageCounts: diagnostics.messageCounts,
      summaryArtifact: diagnostics.summaryArtifact,
      backfillRun: diagnostics.backfillRun,
      activeDegradationEvents: diagnostics.activeDegradationEvents,
    },
    summaryContext: mapSummary(summary),
    rawHealthCounts: parseHealthCounts(healthRow),
    activeThreads: activeThreads.map((thread) => ({
      threadTs: thread.thread_ts,
      replyCount: thread.reply_count,
      lastActivity: thread.last_activity,
    })),
    surfacedThreadInsights: channelThreadInsights.map(mapThreadInsight),
    topLevelMessages: topLevelMessages.map(mapTopLevelMessage),
    recentMessages: recentMessages.map(mapRecentMessage),
    humanReview: {
      expectedHealth: null,
      expectedSignal: null,
      shouldBeRed: null,
      summaryFairness: null,
      summaryAccuracyNotes: null,
      primaryUserFeeling: null,
      keyEvidence: [],
      reviewer: null,
      reviewedAt: null,
      notes: null,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workspace = await selectWorkspace(options.workspaceId);
  const outputPath = path.resolve(
    options.outputPath ?? buildDefaultOutputPath(workspace.workspace_id),
  );
  const outputDir = path.dirname(outputPath);
  const csvPath = jsonPathToCsvPath(outputPath);

  const allChannels = await getAllChannelsWithState(workspace.workspace_id, {
    activeWindowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
  });

  let channels = allChannels.filter((channel) =>
    options.includeNonReady ? true : channel.status === "ready",
  );

  if (options.channelIds.length > 0) {
    const requested = new Set(options.channelIds);
    channels = channels.filter((channel) => requested.has(channel.channel_id));
  }

  channels = channels
    .sort(
      (left, right) =>
        toInt(right.active_message_count) - toInt(left.active_message_count),
    )
    .slice(0, options.limit);

  if (channels.length === 0) {
    throw new Error("No channels matched the requested export filters.");
  }

  const recentThreadInsights = await getRecentThreadInsights(
    workspace.workspace_id,
    Math.max(100, channels.length * options.threadInsightLimit * 3),
  );
  const threadInsightsByChannel = new Map<string, ThreadInsightRow[]>();
  for (const insight of recentThreadInsights) {
    const existing = threadInsightsByChannel.get(insight.channel_id) ?? [];
    existing.push(insight);
    threadInsightsByChannel.set(insight.channel_id, existing);
  }

  const cases: RealEvalDatasetCase[] = [];
  for (const [index, channel] of channels.entries()) {
    const entry = await buildDatasetCase(
      workspace.workspace_id,
      channel,
      index,
      options,
      threadInsightsByChannel,
    );
    cases.push(entry);
  }

  const dataset: RealEvalDataset = {
    generatedAt: new Date().toISOString(),
    warning:
      "This export contains real workspace data and blank human-review fields. It is a real eval source, but not real ground-truth until a human reviewer labels each case.",
    workspace: {
      workspaceId: workspace.workspace_id,
      teamName: workspace.team_name,
    },
    windowPolicy: getProductWindowPolicyPayload(),
    reviewRubric: {
      expectedHealthValues: ["healthy", "attention", "at-risk"],
      expectedSignalValues: ["stable", "elevated", "escalating"],
      summaryFairnessValues: [
        "fair",
        "mixed",
        "overstated",
        "understated",
        "unsupported",
      ],
      shouldBeRedDefinition:
        "Set shouldBeRed=true only if a human reviewer believes the user-facing red/at-risk/escalating treatment would feel fair for this recent-window snapshot.",
    },
    cases,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2), "utf8");
  fs.writeFileSync(csvPath, buildCsvIndex(dataset), "utf8");

  console.log("Real eval dataset export complete");
  console.log(`Workspace: ${workspace.workspace_id} (${workspace.team_name ?? "unknown"})`);
  console.log(`Cases: ${cases.length}`);
  console.log(`JSON: ${outputPath}`);
  console.log(`CSV: ${csvPath}`);
  console.log(
    "Important: these are real channel snapshots with blank human labels. Fill the CSV/JSON review fields to turn this into real ground truth.",
  );
}

main()
  .catch((error) => {
    console.error("Failed to export real eval dataset");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown().catch(() => undefined);
  });
