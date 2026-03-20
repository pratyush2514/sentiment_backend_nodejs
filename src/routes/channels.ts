import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import {
  enqueueBackfill,
  enqueueLLMAnalyze,
  enqueueLLMAnalyzeBatches,
  enqueueSummaryRollup,
} from "../queue/boss.js";
import { resolveSurfaceAnalysis } from "../services/analysisSurface.js";
import { isTsWithinAnalysisWindow } from "../services/analysisWindow.js";
import { persistCanonicalChannelState } from "../services/canonicalChannelState.js";
import {
  hydrateChannelCanonicalSignals,
  reclassifyChannelCanonicalSignals,
  shouldRepairMissingCanonicalSignals,
} from "../services/canonicalMessageSignals.js";
import { discoverChannels } from "../services/channelDiscovery.js";
import { resolveChannelMetadata } from "../services/channelMetadata.js";
import { resolveChannelMode } from "../services/channelMode.js";
import { buildChannelRiskState } from "../services/channelRisk.js";
import {
  getRiskOnlyMonitoringNotice,
  resolveConversationImportance,
  tierRequiresRiskOnlyMonitoring,
} from "../services/conversationImportance.js";
import {
  isManagerRelevantThreadInsight,
  isSurfaceableCrucialMoment,
  normalizeCrucialMoments,
} from "../services/threadInsightPolicy.js";
import { logger } from "../utils/logger.js";
import type { EnrichedMessageWithAnalyticsRow } from "../types/database.js";
import type { Response } from "express";

export const channelsRouter = Router();

const log = logger.child({ route: "channels" });

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

function deriveSentimentTrend(
  sentiment: db.UserSentimentSummary | undefined,
): "improving" | "stable" | "declining" | "insufficient" {
  if (!sentiment || sentiment.totalMessages < 3) return "insufficient";
  if (sentiment.frustrationScore >= 40) return "declining";
  if (sentiment.frustrationScore >= 15) return "stable";
  return "improving";
}

function responseCommitted(res: Response): boolean {
  return res.headersSent || res.writableEnded;
}

function readSignalString(
  signals: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = signals?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readSignalBoolean(
  signals: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  const value = signals?.[key];
  return value === true || value === "true";
}

function buildRelatedIncidentPayload(
  signals: Record<string, unknown> | null | undefined,
): {
  kind: "referenced_external_incident";
  sourceChannelName: string;
  sourceChannelId: string | null;
  blocksLocalWork: boolean;
  incidentFamily: string | null;
} | null {
  const kind = readSignalString(signals, "relatedIncidentKind");
  const sourceChannelName = readSignalString(
    signals,
    "relatedIncidentSourceChannelName",
  );

  if (kind !== "referenced_external_incident" || !sourceChannelName) {
    return null;
  }

  return {
    kind,
    sourceChannelName,
    sourceChannelId: null,
    blocksLocalWork: readSignalBoolean(signals, "relatedIncidentBlocksLocalWork"),
    incidentFamily: readSignalString(signals, "relatedIncidentFamily"),
  };
}

function shouldReclassifySuspiciousIncidentSignals(input: {
  healthCountsRow?: { automation_incident_count?: string | number | null } | null;
  effectiveChannelMode: string;
}): boolean {
  return (
    input.effectiveChannelMode === "collaboration" &&
    Number.parseInt(
      String(input.healthCountsRow?.automation_incident_count ?? "0"),
      10,
    ) > 0
  );
}

function sanitizeRunningSummaryForChannelView(input: {
  summary: string;
  effectiveChannelMode: string;
  localAutomationIncidentCount: number;
  relatedIncidents: Array<{ sourceChannelName: string | null }>;
}): string {
  const summary = input.summary.trim();
  if (
    !summary ||
    input.effectiveChannelMode !== "collaboration" ||
    input.localAutomationIncidentCount > 0 ||
    input.relatedIncidents.length === 0
  ) {
    return summary;
  }

  const relatedChannelPatterns = input.relatedIncidents
    .map((incident) => incident.sourceChannelName?.trim())
    .filter((name): name is string => Boolean(name))
    .map((name) => new RegExp(`#?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));

  const filtered = summary
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      if (/\boperational incident\b/i.test(sentence)) {
        return false;
      }

      return !relatedChannelPatterns.some((pattern) => pattern.test(sentence));
    })
    .join(" ")
    .trim();

  return filtered || summary;
}

const MANUAL_ANALYSIS_SCOPE_LIMIT = 50;

function normalizeTargetMessageTs(targetMessageTs?: string[] | null): string[] {
  return Array.from(
    new Set(
      (targetMessageTs ?? [])
        .filter((target): target is string => typeof target === "string" && target.trim().length > 0)
        .map((target) => target.trim()),
    ),
  );
}

async function queueManualAnalysisJobs(input: {
  workspaceId: string;
  channelId: string;
  mode: "channel" | "thread" | "visible_messages" | "thread_messages";
  threadTs?: string;
  targetMessageTs?: string[] | null;
}): Promise<{ jobIds: string[]; effectiveMode: "latest" | "visible_messages" | "thread_messages" }> {
  const { workspaceId, channelId, mode, threadTs } = input;
  const explicitTargets = normalizeTargetMessageTs(input.targetMessageTs);
  const analysisWindowDays = await db.getEffectiveAnalysisWindowDays(
    workspaceId,
    channelId,
  );
  const analysisWindowHours = analysisWindowDays * 24;
  const windowedExplicitTargets = explicitTargets.filter((ts) =>
    isTsWithinAnalysisWindow(ts, analysisWindowDays),
  );

  if (explicitTargets.length > 0 && windowedExplicitTargets.length === 0) {
    return {
      jobIds: [],
      effectiveMode:
        mode === "thread" || mode === "thread_messages"
          ? "thread_messages"
          : mode === "visible_messages"
            ? "visible_messages"
            : "latest",
    };
  }

  if (mode === "visible_messages") {
    if (windowedExplicitTargets.length === 0) {
      return { jobIds: [], effectiveMode: "visible_messages" };
    }

    const jobIds = await enqueueLLMAnalyzeBatches({
      workspaceId,
      channelId,
      triggerType: "manual",
      mode: "visible_messages",
      threadTs: null,
      targetMessageTs: windowedExplicitTargets,
    });

    return { jobIds, effectiveMode: "visible_messages" };
  }

  if (mode === "thread_messages") {
    const targets = windowedExplicitTargets.length > 0
      ? windowedExplicitTargets
      : await db.getUnresolvedMessageTs(workspaceId, channelId, {
          threadTs: threadTs ?? null,
          limit: MANUAL_ANALYSIS_SCOPE_LIMIT,
          hoursBack: analysisWindowHours,
        });

    if (targets.length > 0) {
      const jobIds = await enqueueLLMAnalyzeBatches({
        workspaceId,
        channelId,
        triggerType: "manual",
        mode: "thread_messages",
        threadTs: threadTs ?? null,
        targetMessageTs: targets,
      });

      return { jobIds, effectiveMode: "thread_messages" };
    }

    const latestJobId = await enqueueLLMAnalyze({
      workspaceId,
      channelId,
      triggerType: "manual",
      threadTs: threadTs ?? null,
    });

    return {
      jobIds: latestJobId ? [latestJobId] : [],
      effectiveMode: "latest",
    };
  }

  if (mode === "thread") {
    const targets = await db.getUnresolvedMessageTs(workspaceId, channelId, {
      threadTs: threadTs ?? null,
      limit: MANUAL_ANALYSIS_SCOPE_LIMIT,
      hoursBack: analysisWindowHours,
    });

    if (targets.length > 0) {
      const jobIds = await enqueueLLMAnalyzeBatches({
        workspaceId,
        channelId,
        triggerType: "manual",
        mode: "thread_messages",
        threadTs: threadTs ?? null,
        targetMessageTs: targets,
      });

      return { jobIds, effectiveMode: "thread_messages" };
    }

    const latestJobId = await enqueueLLMAnalyze({
      workspaceId,
      channelId,
      triggerType: "manual",
      threadTs: threadTs ?? null,
    });

    return {
      jobIds: latestJobId ? [latestJobId] : [],
      effectiveMode: "latest",
    };
  }

  const targets = await db.getUnresolvedMessageTs(workspaceId, channelId, {
    limit: MANUAL_ANALYSIS_SCOPE_LIMIT,
    hoursBack: analysisWindowHours,
  });

  if (targets.length > 0) {
    const jobIds = await enqueueLLMAnalyzeBatches({
      workspaceId,
      channelId,
      triggerType: "manual",
      mode: "visible_messages",
      threadTs: null,
      targetMessageTs: targets,
    });

    return { jobIds, effectiveMode: "visible_messages" };
  }

  const latestJobId = await enqueueLLMAnalyze({
    workspaceId,
    channelId,
    triggerType: "manual",
    threadTs: null,
  });

  return {
    jobIds: latestJobId ? [latestJobId] : [],
    effectiveMode: "latest",
  };
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const channelIdParam = z.object({
  channelId: z.string().regex(/^[A-Z0-9]{1,20}$/i, "Invalid channel ID format"),
});

const workspaceQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
});

const messagesQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
});

const analyticsQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
  emotion: z.enum(["anger", "disgust", "fear", "joy", "neutral", "sadness", "surprise"]).optional(),
  risk: z.enum(["low", "medium", "high", "flagged"]).optional(),
});

const backfillBody = z.object({
  reason: z.string().max(200).optional().default("manual_trigger"),
});

const analyzeBody = z.object({
  mode: z.enum(["channel", "thread", "visible_messages", "thread_messages"]).optional().default("channel"),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
  targetMessageTs: z.array(z.string()).optional(),
});

const timelineQuery = workspaceQuery.extend({
  granularity: z.enum(["hourly", "daily"]).optional().default("daily"),
  limit: z.coerce.number().int().min(1).max(365).optional().default(30),
  from: z.string().optional(),
  to: z.string().optional(),
});

const liveMessagesQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).optional().default(40),
  group: z.enum(["threaded", "flat"]).optional().default("threaded"),
  participantId: z.string().optional(),
});

const rollupBody = z.object({
  mode: z.enum(["channel", "thread", "backfill"]).optional().default("channel"),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatEnrichedMessage(
  m: EnrichedMessageWithAnalyticsRow,
  crucialReasonsByTs: Map<string, string | null> = new Map(),
) {
  const raw = (m.ma_raw_llm_response ?? {}) as Record<string, unknown>;
  const surfacedAnalysis = m.ma_dominant_emotion
    ? resolveSurfaceAnalysis({
        dominantEmotion: m.ma_dominant_emotion,
        interactionTone: m.ma_interaction_tone,
        rawInteractionTone: (raw.interaction_tone as string | undefined) ?? null,
        escalationRisk: m.ma_escalation_risk ?? "low",
        sarcasmDetected: (raw.sarcasm_detected as boolean) ?? false,
        messageText: m.text,
      })
    : null;
  const triage = m.mt_candidate_kind
    ? {
        candidateKind: m.mt_candidate_kind,
        signalType: m.mt_signal_type ?? null,
        severity: m.mt_severity ?? "none",
        stateImpact: m.mt_state_impact ?? "none",
        evidenceType: m.mt_evidence_type ?? null,
        channelMode: m.mt_channel_mode ?? null,
        originType: m.mt_origin_type ?? null,
        confidence: m.mt_confidence ?? null,
        incidentFamily: m.mt_incident_family ?? "none",
        surfacePriority: m.mt_surface_priority ?? "none",
        reasonCodes: m.mt_reason_codes ?? [],
        stateTransition: m.mt_state_transition ?? null,
        relatedIncident: buildRelatedIncidentPayload(m.mt_signals_json),
      }
    : null;

  return {
    ts: m.ts,
    userId: m.user_id,
    displayName: m.display_name ?? m.real_name ?? m.user_id,
    text: m.text,
    files: m.files_json ?? [],
    links: m.links_json ?? [],
    threadTs: m.thread_ts ?? undefined,
    source: m.source,
    analysisStatus: m.analysis_status,
    createdAt: m.created_at,
    analysis: m.ma_dominant_emotion && surfacedAnalysis
      ? {
          emotion: surfacedAnalysis.emotion,
          interactionTone: surfacedAnalysis.interactionTone,
          confidence: m.ma_confidence ?? 0,
          escalationRisk: m.ma_escalation_risk ?? "low",
          explanation: surfacedAnalysis.explanationOverride ?? m.ma_explanation ?? "",
          sarcasmDetected: (raw.sarcasm_detected as boolean) ?? false,
          triggerPhrases: (raw.trigger_phrases as string[]) ?? [],
          behavioralPattern: (raw.behavioral_pattern as string) ?? null,
          messageIntent: m.ma_message_intent ?? null,
          isActionable: m.ma_is_actionable ?? false,
          isBlocking: m.ma_is_blocking ?? false,
          urgencyLevel: m.ma_urgency_level ?? "none",
        }
      : null,
    followUp: m.fu_id
      ? {
          itemId: m.fu_id,
          seriousness: m.fu_seriousness ?? "low",
          summary: m.fu_summary ?? "",
          dueAt: m.fu_due_at ?? null,
          repeatedAskCount: m.fu_repeated_ask_count ?? 0,
        }
      : null,
    triage,
    isCrucial: crucialReasonsByTs.has(m.ts),
    crucialReason: crucialReasonsByTs.get(m.ts) ?? null,
  };
}

function buildCrucialReasonLookup(
  insight: Awaited<ReturnType<typeof db.getThreadInsight>> | null,
): Map<string, string | null> {
  const lookup = new Map<string, string | null>();

  for (const moment of normalizeCrucialMoments(insight?.crucial_moments_json ?? [])) {
    if (!moment.messageTs || !isSurfaceableCrucialMoment(moment)) {
      continue;
    }

    if (!lookup.has(moment.messageTs)) {
      lookup.set(moment.messageTs, moment.reason || null);
    }
  }

  return lookup;
}

function threadInsightPayload(insight: Awaited<ReturnType<typeof db.getThreadInsight>>) {
  if (!insight) return null;
  return {
    summary: insight.summary,
    primaryIssue: insight.primary_issue,
    threadState: insight.thread_state,
    emotionalTemperature: insight.emotional_temperature,
    operationalRisk: insight.operational_risk,
    surfacePriority: insight.surface_priority,
    openQuestions: insight.open_questions_json ?? [],
    crucialMoments: insight.crucial_moments_json ?? [],
    lastMeaningfulChangeTs: insight.last_meaningful_change_ts,
    updatedAt: insight.updated_at,
  };
}

function allowsLowValueThreadInsight(
  insight: NonNullable<Awaited<ReturnType<typeof db.getThreadInsight>>>,
): boolean {
  return (
    insight.thread_state === "blocked" ||
    insight.thread_state === "escalated" ||
    insight.operational_risk === "high" ||
    insight.surface_priority === "high"
  );
}

function shouldSurfaceThreadForChannelView(
  insight: Awaited<ReturnType<typeof db.getThreadInsight>>,
  effectiveImportanceTier: "high_value" | "standard" | "low_value",
): boolean {
  if (!insight) {
    return false;
  }

  if (!isManagerRelevantThreadInsight({
    threadState: insight.thread_state,
    operationalRisk: insight.operational_risk,
    emotionalTemperature: insight.emotional_temperature,
    surfacePriority: insight.surface_priority,
    openQuestions: insight.open_questions_json,
    crucialMoments: insight.crucial_moments_json,
  })) {
    return false;
  }

  return effectiveImportanceTier !== "low_value" || allowsLowValueThreadInsight(insight);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

channelsRouter.get("/", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  try {
    const [rows, healthCountRows, policies] = await Promise.all([
      db.getAllChannelsWithState(workspaceId),
      db.getChannelHealthCounts(workspaceId),
      db.listConversationPolicies(workspaceId),
    ]);
    const healthCountMap = new Map(healthCountRows.map((h) => [h.channel_id, h]));
    const policyMap = new Map(policies.map((policy) => [policy.channel_id, policy]));
    const sparklineRows = await db.getChannelSentimentSparklines(
      workspaceId,
      rows
        .filter((row) => row.status === "ready")
        .map((row) => row.channel_id),
      7,
    );
    const sparklineMap = new Map(
      sparklineRows.map((row) => [row.channelId, row.sparkline]),
    );

    const channels = rows.map((r) => {
      const hc = healthCountMap.get(r.channel_id);
      const policy = policyMap.get(r.channel_id);
      const channelMode = resolveChannelMode({
        channelName: r.name ?? r.channel_id,
        conversationType: policy?.conversation_type ?? r.conversation_type ?? "public_channel",
        channelModeOverride: policy?.channel_mode_override,
      });
      const riskState = buildChannelRiskState(hc, {
        effectiveChannelMode: channelMode.effectiveChannelMode,
      });
      return {
        channelId: r.channel_id,
        name: r.name ?? null,
        status: r.status,
        conversationType: r.conversation_type ?? "public_channel",
        messageCount: Number(r.message_count ?? 0),
        initializedAt: r.initialized_at ?? null,
        lastActivity: r.last_event_at ?? null,
        updatedAt: r.updated_at ?? null,
        sentimentSnapshot: riskState.sentimentSnapshot,
        runningSummary: r.running_summary ?? "",
        healthCounts: {
          openAlertCount: riskState.healthCounts.openAlertCount,
          highSeverityAlertCount: riskState.healthCounts.highSeverityAlertCount,
          automationIncidentCount: riskState.healthCounts.automationIncidentCount,
          criticalAutomationIncidentCount: riskState.healthCounts.criticalAutomationIncidentCount,
          automationIncident24hCount: riskState.healthCounts.automationIncident24hCount,
          criticalAutomationIncident24hCount: riskState.healthCounts.criticalAutomationIncident24hCount,
          humanRiskSignalCount: riskState.healthCounts.humanRiskSignalCount,
          requestSignalCount: riskState.healthCounts.requestSignalCount,
          decisionSignalCount: riskState.healthCounts.decisionSignalCount,
          resolutionSignalCount: riskState.healthCounts.resolutionSignalCount,
          flaggedMessageCount: riskState.healthCounts.flaggedMessageCount,
          highRiskMessageCount: riskState.healthCounts.highRiskMessageCount,
          attentionThreadCount: riskState.healthCounts.attentionThreadCount,
          blockedThreadCount: riskState.healthCounts.blockedThreadCount,
          escalatedThreadCount: riskState.healthCounts.escalatedThreadCount,
          riskyThreadCount: riskState.healthCounts.riskyThreadCount,
          totalMessageCount: riskState.healthCounts.totalMessageCount,
          skippedMessageCount: riskState.healthCounts.skippedMessageCount,
          contextOnlyMessageCount: riskState.healthCounts.contextOnlyMessageCount,
          ignoredMessageCount: riskState.healthCounts.ignoredMessageCount,
          inflightMessageCount: riskState.healthCounts.inflightMessageCount,
        },
        signal: riskState.signal,
        signalConfidence: riskState.signalConfidence,
        health: riskState.health,
        effectiveChannelMode: riskState.effectiveChannelMode,
        riskDrivers: riskState.riskDrivers,
        attentionSummary: riskState.attentionSummary,
        messageDispositionCounts: riskState.messageDispositionCounts,
        sparklineData: sparklineMap.get(r.channel_id) ?? [],
      };
    });

    res.json({ total: channels.length, channels });
  } catch (err) {
    log.error({ err, workspaceId }, "Failed to list channels");
    res.status(500).json({ error: "list_failed", message: "Failed to list channels", requestId: req.id });
  }
});

channelsRouter.get("/:channelId/state", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found" });
    return;
  }

  const [initialState, messageCount, participantCounts, threads, initialHealthCountRows, rule] = await Promise.all([
    db.getChannelState(workspaceId, channelId),
    db.getMessageCount(workspaceId, channelId),
    db.getChannelParticipantCounts(workspaceId, channelId),
    db.getThreads(workspaceId, channelId),
    db.getChannelHealthCounts(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  let state = initialState;
  let healthCountRows = initialHealthCountRows;
  let hc = healthCountRows[0];
  const importance = resolveConversationImportance({
    channelName: channel.name ?? channel.channel_id,
    conversationType: rule?.conversation_type ?? channel.conversation_type ?? "public_channel",
    clientUserIds: rule?.client_user_ids ?? [],
    importanceTierOverride: rule?.importance_tier_override,
  });
  const channelMode = resolveChannelMode({
    channelName: channel.name ?? channel.channel_id,
    conversationType: rule?.conversation_type ?? channel.conversation_type ?? "public_channel",
    channelModeOverride: rule?.channel_mode_override,
  });
  let refreshedCanonicalSignals = false;
  if (shouldRepairMissingCanonicalSignals(hc)) {
    const repair = await hydrateChannelCanonicalSignals({
      workspaceId,
      channelId,
      channel,
      rule,
      windowDays: Number(hc?.analysis_window_days ?? 7),
    });

    if (repair.hydratedCount > 0) {
      refreshedCanonicalSignals = true;
    }
  }
  if (
    shouldReclassifySuspiciousIncidentSignals({
      healthCountsRow: hc,
      effectiveChannelMode: channelMode.effectiveChannelMode,
    })
  ) {
    const reclassification = await reclassifyChannelCanonicalSignals({
      workspaceId,
      channelId,
      channel,
      rule,
      windowDays: Number(hc?.analysis_window_days ?? 7),
    });
    if (reclassification.reclassifiedCount > 0) {
      refreshedCanonicalSignals = true;
    }
  }
  if (refreshedCanonicalSignals) {
    await persistCanonicalChannelState(workspaceId, channelId, {
      channel,
      rule,
    });
    try {
      await enqueueSummaryRollup({
        workspaceId,
        channelId,
        rollupType: "channel",
        requestedBy: "state_route",
      });
    } catch (err) {
      log.warn({ err, channelId }, "Failed to queue summary rollup after canonical repair");
    }
    if (responseCommitted(res)) {
      return;
    }
    [state, healthCountRows] = await Promise.all([
      db.getChannelState(workspaceId, channelId),
      db.getChannelHealthCounts(workspaceId, channelId),
    ]);
    hc = healthCountRows[0];
  }
  if (responseCommitted(res)) {
    return;
  }
  const riskState = buildChannelRiskState(hc, {
    effectiveChannelMode: channelMode.effectiveChannelMode,
  });

  const userIds = participantCounts.map((participant) => participant.user_id);
  const [
    profiles,
    roleAssignments,
    sentimentSummaries,
    threadInsights,
    relatedIncidentRows,
  ] = await Promise.all([
    db.getUserProfiles(workspaceId, userIds),
    db.getRoleAssignmentsForUsers(workspaceId, userIds),
    db.getUserSentimentSummaries(workspaceId, channelId),
    db.getThreadInsightsBatch(
      workspaceId,
      channelId,
      threads.map((thread) => thread.thread_ts),
    ),
    db.getRelatedIncidentMentions(
      workspaceId,
      channelId,
      riskState.healthCounts.analysisWindowDays,
      5,
    ),
  ]);
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
  const roleMap = new Map(roleAssignments.map((r) => [r.user_id, r]));
  const sentimentMap = new Map(sentimentSummaries.map((s) => [s.userId, s]));
  const threadInsightMap = new Map(threadInsights.map((insight) => [insight.thread_ts, insight]));
  const surfacedThreads = threads.filter((thread) =>
    shouldSurfaceThreadForChannelView(
      threadInsightMap.get(thread.thread_ts) ?? null,
      importance.effectiveImportanceTier,
    ),
  );

  const participantCountMap = new Map(
    participantCounts.map((participant) => [participant.user_id, participant.message_count]),
  );

  const participants = userIds
    .map((userId) => {
      const profile = profileMap.get(userId);
      const roleAssignment = roleMap.get(userId);
      const sentiment = sentimentMap.get(userId);
      return {
        userId,
        displayName: profile?.display_name ?? profile?.real_name ?? userId,
        profileImage: profile?.profile_image ?? null,
        messageCount: participantCountMap.get(userId) ?? 0,
        role: roleAssignment?.role ?? null,
        displayLabel: roleAssignment?.display_label ?? null,
        dominantEmotion: sentiment?.dominantEmotion ?? null,
        frustrationScore: sentiment?.frustrationScore ?? 0,
        sentimentTrend: deriveSentimentTrend(sentiment),
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);

  if (responseCommitted(res)) {
    return;
  }
  res.status(200).json({
    channelId: channel.channel_id,
    channelName: channel.name ?? channel.channel_id,
    conversationType: channel.conversation_type ?? "public_channel",
    status: channel.status,
    importanceTierOverride: importance.importanceTierOverride,
    recommendedImportanceTier: importance.recommendedImportanceTier,
    effectiveImportanceTier: importance.effectiveImportanceTier,
    channelModeOverride: channelMode.channelModeOverride,
    recommendedChannelMode: channelMode.recommendedChannelMode,
    effectiveChannelMode: channelMode.effectiveChannelMode,
    initializedAt: channel.initialized_at,
    updatedAt: channel.updated_at,
    lastEventAt: channel.last_event_at,
    runningSummary:
      tierRequiresRiskOnlyMonitoring(importance.effectiveImportanceTier)
        ? getRiskOnlyMonitoringNotice()
        : sanitizeRunningSummaryForChannelView({
            summary: state?.running_summary ?? "",
            effectiveChannelMode: channelMode.effectiveChannelMode,
            localAutomationIncidentCount:
              riskState.healthCounts.automationIncidentCount,
            relatedIncidents: relatedIncidentRows.map((incident) => ({
              sourceChannelName: incident.source_channel_name,
            })),
          }),
    keyDecisions: state?.key_decisions_json ?? [],
    sentimentSnapshot: riskState.sentimentSnapshot,
    healthCounts: {
      openAlertCount: riskState.healthCounts.openAlertCount,
      highSeverityAlertCount: riskState.healthCounts.highSeverityAlertCount,
      automationIncidentCount: riskState.healthCounts.automationIncidentCount,
      criticalAutomationIncidentCount: riskState.healthCounts.criticalAutomationIncidentCount,
      automationIncident24hCount: riskState.healthCounts.automationIncident24hCount,
      criticalAutomationIncident24hCount: riskState.healthCounts.criticalAutomationIncident24hCount,
      humanRiskSignalCount: riskState.healthCounts.humanRiskSignalCount,
      requestSignalCount: riskState.healthCounts.requestSignalCount,
      decisionSignalCount: riskState.healthCounts.decisionSignalCount,
      resolutionSignalCount: riskState.healthCounts.resolutionSignalCount,
      flaggedMessageCount: riskState.healthCounts.flaggedMessageCount,
      highRiskMessageCount: riskState.healthCounts.highRiskMessageCount,
      attentionThreadCount: riskState.healthCounts.attentionThreadCount,
      blockedThreadCount: riskState.healthCounts.blockedThreadCount,
      escalatedThreadCount: riskState.healthCounts.escalatedThreadCount,
      riskyThreadCount: riskState.healthCounts.riskyThreadCount,
      totalMessageCount: riskState.healthCounts.totalMessageCount,
      skippedMessageCount: riskState.healthCounts.skippedMessageCount,
      contextOnlyMessageCount: riskState.healthCounts.contextOnlyMessageCount,
      ignoredMessageCount: riskState.healthCounts.ignoredMessageCount,
      inflightMessageCount: riskState.healthCounts.inflightMessageCount,
    },
    windowStats: {
      analysisWindowDays: riskState.healthCounts.analysisWindowDays,
      messageCountInWindow: riskState.healthCounts.totalMessageCount,
      analyzedMessageCount: riskState.sentimentSnapshot.totalAnalyzed,
      skippedMessageCount: riskState.healthCounts.skippedMessageCount,
      contextOnlyMessageCount: riskState.healthCounts.contextOnlyMessageCount,
      ignoredMessageCount: riskState.healthCounts.ignoredMessageCount,
      inflightMessageCount: riskState.healthCounts.inflightMessageCount,
    },
    signal: riskState.signal,
    signalConfidence: riskState.signalConfidence,
    health: riskState.health,
    riskDrivers: riskState.riskDrivers,
    attentionSummary: riskState.attentionSummary,
    messageDispositionCounts: riskState.messageDispositionCounts,
    relatedIncidents: relatedIncidentRows.map((incident) => ({
      sourceChannelId: incident.source_channel_id,
      sourceChannelName: incident.source_channel_name ?? "unknown",
      kind: "referenced_external_incident",
      message: incident.message_text,
      detectedAt: incident.detected_at,
      blocksLocalWork: incident.blocks_local_work,
      incidentFamily: incident.incident_family,
    })),
    participants,
    activeThreads: surfacedThreads.map((t) => ({
      threadTs: t.thread_ts,
      replyCount: t.reply_count,
      lastActivity: t.last_activity,
      summary: threadInsightMap.get(t.thread_ts)?.summary ?? "Live thread activity",
      openQuestions: threadInsightMap.get(t.thread_ts)?.open_questions_json ?? [],
      threadInsight: threadInsightPayload(threadInsightMap.get(t.thread_ts) ?? null),
    })),
    messageCount,
  });
});

channelsRouter.get("/:channelId/messages", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = messagesQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const limit = query.data.limit;
  const threadTs = query.data.threadTs ?? null;

  if (threadTs) {
    const [threadMessages, threadInsight] = await Promise.all([
      db.getMessagesEnriched(workspaceId, channelId, { limit, threadTs }),
      db.getThreadInsight(workspaceId, channelId, threadTs),
    ]);
    const crucialReasonsByTs = buildCrucialReasonLookup(threadInsight);
    res.status(200).json({
      channelId,
      threadTs,
      total: threadMessages.length,
      returned: threadMessages.length,
      messages: threadMessages.map((message) => formatEnrichedMessage(message, crucialReasonsByTs)),
      threadInsight: threadInsightPayload(threadInsight),
    });
    return;
  }

  const topMessages = await db.getTopLevelMessagesEnriched(workspaceId, channelId, limit);

  const threadsToFetch = topMessages.filter((m) => m.reply_count > 0);
  const repliesMap = new Map<string, Awaited<ReturnType<typeof db.getThreadRepliesEnriched>>>();

  await Promise.all(
    threadsToFetch.map(async (m) => {
      const replies = await db.getThreadRepliesEnriched(workspaceId, channelId, m.ts);
      repliesMap.set(m.ts, replies);
    }),
  );

  const formatted = topMessages.map((m) => {
    const replies = repliesMap.get(m.ts) ?? [];
    return {
      ts: m.ts,
      userId: m.user_id,
      displayName: m.display_name ?? m.real_name ?? m.user_id,
      text: m.text,
      files: m.files_json ?? [],
      links: m.links_json ?? [],
      source: m.source,
      analysisStatus: m.analysis_status,
      createdAt: m.created_at,
      replyCount: m.reply_count,
      replies: replies.map((r) => ({
        ts: r.ts,
        userId: r.user_id,
        displayName: r.display_name ?? r.real_name ?? r.user_id,
        text: r.text,
        files: r.files_json ?? [],
        links: r.links_json ?? [],
        createdAt: r.created_at,
      })),
    };
  });

  res.status(200).json({
    channelId,
    total: topMessages.length,
    returned: formatted.length,
    messages: formatted,
  });
});

channelsRouter.get("/:channelId/threads", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const threads = await db.getActiveThreads(workspaceId, channelId, 24);
  const [threadInsights, rule] = await Promise.all([
    db.getThreadInsightsBatch(
      workspaceId,
      channelId,
      threads.map((thread) => thread.thread_ts),
    ),
    db.getFollowUpRule(workspaceId, channelId),
  ]);
  const threadInsightMap = new Map(threadInsights.map((insight) => [insight.thread_ts, insight]));
  const importance = resolveConversationImportance({
    channelName: channel.name ?? channel.channel_id,
    conversationType: rule?.conversation_type ?? channel.conversation_type ?? "public_channel",
    clientUserIds: rule?.client_user_ids ?? [],
    importanceTierOverride: rule?.importance_tier_override,
  });

  const enrichedThreads = await Promise.all(
    threads.map(async (thread) => {
      const rootMessages = await db.getMessagesEnriched(workspaceId, channelId, {
        limit: 1,
        threadTs: thread.thread_ts,
      });
      const root = rootMessages[0] ?? null;
      const insight = threadInsightMap.get(thread.thread_ts) ?? null;

      return {
        threadTs: thread.thread_ts,
        replyCount: thread.reply_count,
        lastActivity: thread.last_activity,
        summary: insight?.summary ?? null,
        openQuestions: insight?.open_questions_json ?? [],
        threadInsight: threadInsightPayload(insight),
        rootMessage: root
          ? {
              ts: root.ts,
              userId: root.user_id,
              displayName: root.display_name ?? root.real_name ?? root.user_id,
              text: root.text,
            }
          : null,
      };
    }),
  );
  const surfacedThreads = enrichedThreads.filter((thread) =>
    shouldSurfaceThreadForChannelView(
      threadInsightMap.get(thread.threadTs) ?? null,
      importance.effectiveImportanceTier,
    ),
  );
  const surfacedThreadTs = new Set(surfacedThreads.map((thread) => thread.threadTs));
  const recentThreads = enrichedThreads
    .filter((thread) => !surfacedThreadTs.has(thread.threadTs))
    .slice(0, 4);

  res.status(200).json({
    channelId,
    total: surfacedThreads.length,
    returned: surfacedThreads.length,
    threads: surfacedThreads,
    recentThreads,
  });
});

channelsRouter.get("/:channelId/analytics", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = analyticsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const limit = query.data.limit;
  const offset = query.data.offset;

  const rows = await db.getMessageAnalytics(workspaceId, channelId, {
    limit,
    offset,
    threadTs: query.data.threadTs ?? null,
    emotion: query.data.emotion ?? null,
    risk: query.data.risk ?? null,
  });

  const totalCount = rows.length > 0 ? rows[0].total_count : 0;

  const analytics = rows.map((r) => {
    const raw = r.raw_llm_response as Record<string, unknown>;
    const surfacedAnalysis = resolveSurfaceAnalysis({
      dominantEmotion: r.dominant_emotion,
      interactionTone: r.interaction_tone,
      rawInteractionTone: (raw.interaction_tone as string | undefined) ?? null,
      escalationRisk: r.escalation_risk,
      sarcasmDetected: (raw.sarcasm_detected as boolean) ?? false,
      messageText: r.message_text,
    });

    return {
      messageTs: r.message_ts,
      messageText: r.message_text,
      threadTs: r.thread_ts,
      user: {
        userId: r.user_id ?? null,
        displayName: r.display_name ?? r.real_name ?? null,
      },
      dominantEmotion: surfacedAnalysis.emotion,
      interactionTone: surfacedAnalysis.interactionTone,
      confidence: r.confidence,
      escalationRisk: r.escalation_risk,
      sarcasmDetected: raw.sarcasm_detected ?? null,
      intendedEmotion: raw.intended_emotion ?? null,
      explanation: surfacedAnalysis.explanationOverride ?? r.explanation,
      themes: r.themes,
      decisionSignal: r.decision_signal,
      llmProvider: r.llm_provider,
      llmModel: r.llm_model,
      tokenUsage: r.token_usage,
      analyzedAt: r.created_at,
      authorFlaggedCount: Number(r.author_flagged_count ?? 0),
    };
  });

  res.status(200).json({
    channelId,
    total: totalCount,
    returned: analytics.length,
    limit,
    offset,
    filters: {
      threadTs: query.data.threadTs ?? null,
      emotion: query.data.emotion ?? null,
      risk: query.data.risk ?? null,
    },
    analytics,
  });
});

/**
 * GET /api/channels/:channelId/timeline
 * Returns time-bucketed sentiment trend data for a channel.
 */
channelsRouter.get("/:channelId/timeline", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = timelineQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  try {
    const buckets = await db.getSentimentTrends(workspaceId, {
      channelId,
      granularity: query.data.granularity,
      from: query.data.from ?? null,
      to: query.data.to ?? null,
      limit: query.data.limit,
    });

    res.json({
      channelId,
      granularity: query.data.granularity,
      total: buckets.length,
      buckets,
    });
  } catch (err) {
    log.error({ err, channelId, workspaceId }, "Failed to fetch timeline");
    res.status(500).json({ error: "timeline_failed", message: "Failed to fetch timeline data", requestId: req.id });
  }
});

/**
 * GET /api/channels/:channelId/live-messages
 * Returns recent messages with full analysis data for the live activity feed.
 */
channelsRouter.get("/:channelId/live-messages", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = liveMessagesQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  try {
    const rows = await db.getMessagesEnriched(workspaceId, channelId, {
      limit: query.data.limit,
      participantId: query.data.participantId ?? null,
    });
    const threadKeys = [...new Set(rows.map((row) => row.thread_ts ?? row.ts))];
    const threadInsights = threadKeys.length > 0
      ? await db.getThreadInsightsBatch(workspaceId, channelId, threadKeys)
      : [];
    const crucialReasonsByThreadKey = new Map(
      threadInsights.map((insight) => [insight.thread_ts, buildCrucialReasonLookup(insight)]),
    );
    const resolveCrucialReasons = (threadKey: string) =>
      crucialReasonsByThreadKey.get(threadKey) ?? new Map<string, string | null>();

    let messages = rows.map((row) =>
      formatEnrichedMessage(row, resolveCrucialReasons(row.thread_ts ?? row.ts)),
    );

    if (query.data.group === "threaded" && !query.data.participantId) {
      const grouped = new Map<
        string,
        {
          latestTs: number;
          messages: ReturnType<typeof formatEnrichedMessage>[];
        }
      >();

      for (const message of messages) {
        const threadKey = message.threadTs ?? message.ts;
        const existing = grouped.get(threadKey) ?? { latestTs: 0, messages: [] };
        existing.messages.push(message);
        existing.latestTs = Math.max(existing.latestTs, Number.parseFloat(message.ts));
        grouped.set(threadKey, existing);
      }

      const missingRootTs = [...grouped.entries()]
        .filter(([threadKey, group]) => threadKey !== group.messages[0]?.ts)
        .filter(([threadKey, group]) => !group.messages.some((message) => message.ts === threadKey))
        .map(([threadKey]) => threadKey);

      if (missingRootTs.length > 0) {
        const rootRows = await db.getMessagesEnrichedByTs(workspaceId, channelId, missingRootTs);
        for (const rootRow of rootRows) {
          const group = grouped.get(rootRow.ts);
          if (!group) continue;
          group.messages.push(
            formatEnrichedMessage(rootRow, resolveCrucialReasons(rootRow.thread_ts ?? rootRow.ts)),
          );
        }
      }

      messages = [...grouped.values()]
        .sort((left, right) => right.latestTs - left.latestTs)
        .flatMap((group) =>
          [...group.messages].sort(
            (left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts),
          ),
        );
    } else {
      messages = [...messages].sort(
        (left, right) => Number.parseFloat(right.ts) - Number.parseFloat(left.ts),
      );
    }

    res.json({
      channelId,
      total: messages.length,
      returned: messages.length,
      messages,
    });
  } catch (err) {
    log.error({ err, channelId, workspaceId }, "Failed to fetch live messages");
    res.status(500).json({ error: "live_messages_failed", message: "Failed to fetch live messages", requestId: req.id });
  }
});

/**
 * POST /api/channels/:channelId/rollup
 * Queues a summary rollup job for a channel or thread.
 */
channelsRouter.post("/:channelId/rollup", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }
  const body = rollupBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const { mode, threadTs } = body.data;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  if (mode === "thread" && !threadTs) {
    res.status(400).json({ error: "invalid_body", message: "threadTs is required when mode is 'thread'", requestId: req.id });
    return;
  }

  try {
    const jobId = await enqueueSummaryRollup({
      workspaceId,
      channelId,
      rollupType: mode,
      threadTs: threadTs ?? null,
      requestedBy: "manual",
    });

    log.info({ channelId, mode, threadTs, jobId }, "Rollup job queued");
    res.status(202).json({ status: "queued", jobId });
  } catch (err) {
    log.error({ err, channelId, workspaceId }, "Failed to queue rollup");
    res.status(500).json({ error: "rollup_failed", message: "Failed to queue rollup job", requestId: req.id });
  }
});

channelsRouter.post("/:channelId/backfill", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }
  const body = backfillBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const { reason } = body.data;

  const existingChannel = await db.getChannel(workspaceId, channelId);
  const metadata = await resolveChannelMetadata(workspaceId, channelId);

  if (!existingChannel && !metadata) {
    res.status(503).json({
      error: "channel_metadata_unavailable",
      message: "Unable to verify channel privacy in Slack right now. Please try again.",
      retryable: true,
      requestId: req.id,
    });
    return;
  }

  if (metadata) {
    await db.upsertChannel(
      workspaceId,
      channelId,
      existingChannel?.status ?? "pending",
      metadata.name ?? existingChannel?.name ?? null,
      metadata.conversationType,
    );
  }
  const jobId = await enqueueBackfill(workspaceId, channelId, reason);

  log.info({ channelId, reason, jobId }, "Backfill queued");
  res.status(202).json({ status: "queued", channelId, reason, jobId });
});

channelsRouter.post("/:channelId/analyze", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }
  const body = analyzeBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const { mode, threadTs, targetMessageTs } = body.data;

  if ((mode === "thread" || mode === "thread_messages") && !threadTs) {
    res.status(400).json({ error: "invalid_body", message: "threadTs is required for thread analysis", requestId: req.id });
    return;
  }
  if (mode === "visible_messages" && normalizeTargetMessageTs(targetMessageTs).length === 0) {
    res.status(400).json({
      error: "invalid_body",
      message: "targetMessageTs is required when mode is 'visible_messages'",
      requestId: req.id,
    });
    return;
  }

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const { jobIds, effectiveMode } = await queueManualAnalysisJobs({
    workspaceId,
    channelId,
    mode,
    threadTs,
    targetMessageTs: targetMessageTs ?? null,
  });
  const jobId = jobIds[0] ?? null;

  log.info({ channelId, mode, effectiveMode, threadTs, queuedCount: jobIds.length, jobId }, "Manual LLM analysis queued");
  res.status(202).json({ status: "queued", channelId, mode, effectiveMode, jobId, queuedCount: jobIds.length });
});

/**
 * POST /api/channels/sync?workspace_id=T1234
 * Discovers all channels the bot is a member of and queues backfill for any not yet tracked.
 */
channelsRouter.post("/sync", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  try {
    const result = await discoverChannels(workspaceId);
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err, workspaceId }, "Channel sync failed");
    res.status(500).json({ error: "sync_failed", message: "Failed to queue channel discovery", requestId: req.id });
  }
});

channelsRouter.get("/:channelId/summary", async (req, res) => {
  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const { channelId } = params.data;
  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const summary = await db.getChannelSummary(workspaceId, channelId);
  if (!summary) {
    res.status(404).json({ error: "channel_state_not_found", requestId: req.id });
    return;
  }

  res.status(200).json({
    channelId,
    ...summary,
  });
});
