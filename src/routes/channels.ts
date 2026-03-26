import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { requireServiceAuth } from "../middleware/apiAuth.js";
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
  fetchChannelTruthCounts,
  fetchChannelTruthSnapshot,
  fetchChannelTruthSnapshots,
  fetchMessageTruthStates,
  type AnalysisExecution,
  type AnalysisEligibility,
  type AnalysisQuality,
  type AnalysisSuppressionReason,
  type MessageTruthState,
} from "../services/intelligenceTruth.js";
import {
  isManagerRelevantThreadInsight,
  isSurfaceableCrucialMoment,
  normalizeCrucialMoments,
} from "../services/threadInsightPolicy.js";
import {
  getProductWindowPolicyPayload,
  getProductWindowStartTs,
  normalizeProductWindowScope,
  PRODUCT_WINDOW_POLICY,
  type ProductWindowScope,
} from "../services/windowPolicy.js";
import { logger } from "../utils/logger.js";
import type {
  EnrichedMessageWithAnalyticsRow,
  MeetingObligationRow,
  MeetingRow,
  RiskDriver,
  SummaryFact,
} from "../types/database.js";
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

function normalizeAnalysisExecution(
  value: unknown,
): AnalysisExecution | null {
  switch (value) {
    case "not_run":
    case "pending":
    case "processing":
    case "completed":
    case "failed":
      return value;
    default:
      return null;
  }
}

function normalizeAnalysisEligibility(
  value: unknown,
): AnalysisEligibility | null {
  switch (value) {
    case "eligible":
    case "not_candidate":
    case "policy_suppressed":
    case "privacy_suppressed":
      return value;
    default:
      return null;
  }
}

function normalizeAnalysisQuality(
  value: unknown,
): AnalysisQuality | null {
  switch (value) {
    case "none":
    case "fallback":
    case "partial":
    case "verified":
      return value;
    default:
      return null;
  }
}

function normalizeAnalysisSuppressionReason(
  value: unknown,
): AnalysisSuppressionReason | null {
  switch (value) {
    case "channel_not_ready":
    case "cooldown":
    case "importance_tier":
    case "privacy_skip":
    case "budget_exceeded":
    case "not_candidate":
      return value;
    default:
      return null;
  }
}

function buildProductWindowPayload(
  defaultScope: ProductWindowScope = PRODUCT_WINDOW_POLICY.defaultScope,
) {
  return getProductWindowPolicyPayload(defaultScope);
}

function resolveWindowScopeStartTs(
  scope: ProductWindowScope,
): string | null {
  return getProductWindowStartTs(scope);
}

function deriveLegacyMessageTruth(message: {
  analysisStatus: string;
  analysis?: { emotion?: unknown } | null;
}): MessageTruthState {
  const execution = normalizeAnalysisExecution(message.analysisStatus);
  const derivedEligibility = normalizeAnalysisEligibility(
    message.analysisStatus === "skipped" ? "not_candidate" : "eligible",
  );
  const derivedQuality = normalizeAnalysisQuality(
    message.analysisStatus === "completed"
      ? "verified"
      : message.analysisStatus === "failed"
        ? "none"
        : message.analysisStatus === "skipped"
          ? "none"
          : message.analysis?.emotion
            ? "partial"
            : null,
  );
  const derivedSuppressionReason = normalizeAnalysisSuppressionReason(
    message.analysisStatus === "skipped" ? "not_candidate" : null,
  );

  return {
    ts: "",
    analysisEligibility: derivedEligibility ?? "eligible",
    analysisExecution: execution ?? "not_run",
    analysisQuality: derivedQuality,
    suppressionReason: derivedSuppressionReason,
  };
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

function buildSummaryCoveragePayload(
  startTs: string | null | undefined,
  endTs: string | null | undefined,
): { startTs: string | null; endTs: string | null } | null {
  if (!startTs && !endTs) {
    return null;
  }

  return {
    startTs: startTs ?? null,
    endTs: endTs ?? null,
  };
}

function shouldExposeLiveSummary(input: {
  summary: string;
  coverageEndTs: string | null;
  activeCoverageEndTs: string | null;
}): boolean {
  if (!input.summary.trim()) {
    return false;
  }

  const liveEnd = Number.parseFloat(input.coverageEndTs ?? "");
  const activeEnd = Number.parseFloat(input.activeCoverageEndTs ?? "");

  if (!Number.isFinite(liveEnd)) {
    return true;
  }
  if (!Number.isFinite(activeEnd)) {
    return true;
  }

  return liveEnd > activeEnd;
}

type UnifiedDriverLevel = "positive" | "warning" | "critical";
type UnifiedDriverSource = "slack" | "fathom" | "combined";

interface RecentActivityPayload {
  label: "Recent activity";
  windowHours: number;
  messageCount: number;
  activeThreads: number;
  openFollowUps: number;
  resolvedFollowUps: number;
}

interface LatestMeetingPayload {
  id: string;
  title: string;
  startedAt: string;
  source: "api" | "webhook" | "shared_link";
  confidence: "high" | "medium";
  meetingSentiment: "positive" | "neutral" | "concerned" | "tense" | null;
  summary: string | null;
  openObligations: number;
  overdueObligations: number;
  blockers: string[];
  decisions: string[];
  nextSteps: string[];
}

interface MeetingContextPayload {
  latestMeeting: LatestMeetingPayload;
}

interface UnifiedDriverPayload {
  level: UnifiedDriverLevel;
  source: UnifiedDriverSource;
  message: string;
}

const DRIVER_LEVEL_WEIGHT: Record<UnifiedDriverLevel, number> = {
  positive: 1,
  warning: 2,
  critical: 3,
};

function parseSlackTsToDate(value: string | null | undefined): Date | null {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed * 1000);
}

function parseSlackTsToIso(value: string | null | undefined): string | null {
  return parseSlackTsToDate(value)?.toISOString() ?? null;
}

function buildSummaryEvidencePayload(
  evidence: SummaryFact["evidence"],
): Array<{ messageTs: string; threadTs: string | null; excerpt: string | null }> {
  return evidence.slice(0, 3).map((item) => ({
    messageTs: item.messageTs,
    threadTs: item.threadTs,
    excerpt: item.excerpt,
  }));
}

function buildKeyDecisionPayload(input: {
  legacyKeyDecisions: string[];
  summaryFacts: SummaryFact[];
  fallbackDetectedAt: string | null;
}): Array<
  | string
  | {
      text: string;
      ts?: string;
      messageTs?: string | null;
      threadTs?: string | null;
      detectedAt?: string | null;
      evidence?: Array<{
        messageTs: string;
        threadTs: string | null;
        excerpt: string | null;
      }>;
    }
> {
  const decisionFacts = input.summaryFacts.filter((fact) => fact.kind === "decision");
  if (decisionFacts.length === 0) {
    return input.legacyKeyDecisions;
  }

  return decisionFacts.map((fact) => {
    const evidence = buildSummaryEvidencePayload(fact.evidence);
    const firstEvidence = evidence[0] ?? null;
    const detectedAt =
      parseSlackTsToIso(firstEvidence?.messageTs ?? null) ??
      input.fallbackDetectedAt;
    const threadTs =
      evidence.find((item) => item.threadTs)?.threadTs ??
      firstEvidence?.threadTs ??
      null;

    return {
      text: fact.text,
      ts: threadTs ?? undefined,
      messageTs: firstEvidence?.messageTs ?? null,
      threadTs,
      detectedAt,
      evidence,
    };
  });
}

function normalizeMeetingSentiment(
  value: string | null | undefined,
): LatestMeetingPayload["meetingSentiment"] {
  switch (value) {
    case "positive":
    case "neutral":
    case "concerned":
    case "tense":
      return value;
    default:
      return null;
  }
}

function isLowValueSharedLinkSummary(summary: string): boolean {
  const normalized = summary
    .replace(/[*_`#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  if (normalized.length < 24) {
    return true;
  }

  return (
    /^[a-z0-9_-]*content$/i.test(normalized) ||
    /^(fathom|meeting|summary|notes?)$/i.test(normalized)
  );
}

function cleanMeetingSummary(
  summary: string | null | undefined,
  options?: { source?: MeetingRow["meeting_source"] },
): string | null {
  if (!summary?.trim()) {
    return null;
  }

  const cleaned = summary
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (
    cleaned &&
    options?.source === "shared_link" &&
    isLowValueSharedLinkSummary(cleaned)
  ) {
    return null;
  }

  return cleaned || null;
}

function formatShortDateLabel(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function collectUniqueStrings(
  values: Array<string | null | undefined>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const value of values) {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }
    const dedupeKey = normalized.toLowerCase().replace(/[.?!,:;]+$/g, "");
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    collected.push(normalized);
    if (collected.length >= limit) {
      break;
    }
  }

  return collected;
}

function getMeetingRiskSignals(meeting: MeetingRow): string[] {
  return collectUniqueStrings(
    (meeting.risk_signals_json ?? []).map((signal) => {
      if (
        signal &&
        typeof signal === "object" &&
        "signal" in signal &&
        typeof signal.signal === "string"
      ) {
        return signal.signal;
      }
      return null;
    }),
    5,
  );
}

function formatMeetingNextStep(obligation: MeetingObligationRow): string {
  const owner = obligation.owner_name?.trim() || null;
  const dueLabel = obligation.due_date
    ? ` (due ${formatShortDateLabel(obligation.due_date)})`
    : "";
  return `${owner ? `${owner}: ` : ""}${obligation.title}${dueLabel}`;
}

function withTrailingPeriod(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function buildMeetingContext(
  meeting: MeetingRow,
  obligations: MeetingObligationRow[],
): MeetingContextPayload {
  const isSharedLinkMeeting = meeting.meeting_source === "shared_link";
  const unresolvedObligations = obligations.filter((obligation) =>
    obligation.status === "open" || obligation.status === "in_progress",
  );
  const today = new Date().toISOString().slice(0, 10);
  const overdueObligations = unresolvedObligations.filter(
    (obligation) => obligation.due_date && obligation.due_date < today,
  );
  const blockers = isSharedLinkMeeting
    ? []
    : collectUniqueStrings(
        [
          ...getMeetingRiskSignals(meeting),
          ...unresolvedObligations
            .filter((obligation) => obligation.obligation_type === "risk")
            .map((obligation) => obligation.title),
        ],
        3,
      );
  const decisions = isSharedLinkMeeting
    ? []
    : collectUniqueStrings(
        obligations
          .filter((obligation) => obligation.obligation_type === "decision")
          .map((obligation) => obligation.title),
        3,
      );
  const nextSteps = isSharedLinkMeeting
    ? []
    : collectUniqueStrings(
        unresolvedObligations
          .filter((obligation) =>
            ["action_item", "commitment", "next_step"].includes(
              obligation.obligation_type,
            ),
          )
          .map((obligation) => formatMeetingNextStep(obligation)),
        3,
      );

  return {
    latestMeeting: {
      id: meeting.id,
      title: meeting.title?.trim() || "Untitled meeting",
      startedAt: meeting.started_at.toISOString(),
      source: meeting.meeting_source,
      confidence: meeting.meeting_source === "shared_link" ? "medium" : "high",
      meetingSentiment: normalizeMeetingSentiment(meeting.meeting_sentiment),
      summary: cleanMeetingSummary(meeting.fathom_summary, {
        source: meeting.meeting_source,
      }),
      openObligations: unresolvedObligations.length,
      overdueObligations: overdueObligations.length,
      blockers,
      decisions,
      nextSteps,
    },
  };
}

function shouldIncludeMeetingContext(
  meetingContext: MeetingContextPayload,
  activeWindowStartAt: Date | null,
): boolean {
  if (meetingContext.latestMeeting.openObligations > 0) {
    return true;
  }
  if (!activeWindowStartAt) {
    return true;
  }

  const startedAt = new Date(meetingContext.latestMeeting.startedAt);
  return Number.isFinite(startedAt.getTime())
    ? startedAt.getTime() >= activeWindowStartAt.getTime()
    : false;
}

function normalizeDriverMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

function toUnifiedDriverLevel(
  severity: RiskDriver["severity"],
): UnifiedDriverLevel {
  switch (severity) {
    case "high":
      return "critical";
    case "medium":
      return "warning";
    default:
      return "positive";
  }
}

function dedupeUnifiedDrivers(
  drivers: UnifiedDriverPayload[],
): UnifiedDriverPayload[] {
  const merged = new Map<string, UnifiedDriverPayload>();

  for (const driver of drivers) {
    const dedupeKey = normalizeDriverMessage(driver.message);
    const existing = merged.get(dedupeKey);
    if (!existing) {
      merged.set(dedupeKey, driver);
      continue;
    }

    merged.set(dedupeKey, {
      level:
        DRIVER_LEVEL_WEIGHT[driver.level] > DRIVER_LEVEL_WEIGHT[existing.level]
          ? driver.level
          : existing.level,
      source:
        existing.source === driver.source ? existing.source : "combined",
      message:
        existing.message.length >= driver.message.length
          ? existing.message
          : driver.message,
    });
  }

  return [...merged.values()].sort(
    (left, right) => DRIVER_LEVEL_WEIGHT[right.level] - DRIVER_LEVEL_WEIGHT[left.level],
  );
}

function buildUnifiedDrivers(input: {
  signal: "stable" | "elevated" | "escalating";
  riskDrivers: RiskDriver[];
  recentActivity: RecentActivityPayload;
  meetingContext: MeetingContextPayload | null;
  resolutionSignalCount: number;
  decisionSignalCount: number;
}): UnifiedDriverPayload[] {
  const drivers: UnifiedDriverPayload[] = input.riskDrivers
    .slice(0, 3)
    .map((driver) => ({
      level: toUnifiedDriverLevel(driver.severity),
      source: "slack" as const,
      message: driver.message,
    }));

  const latestMeeting = input.meetingContext?.latestMeeting ?? null;
  const hasSlackPressure =
    input.signal !== "stable" || input.riskDrivers.length > 0;
  const meetingSource: UnifiedDriverSource = hasSlackPressure
    ? "combined"
    : "fathom";

  if (latestMeeting) {
    if (latestMeeting.overdueObligations > 0 || latestMeeting.openObligations > 0) {
      drivers.push({
        level: latestMeeting.overdueObligations > 0 ? "critical" : "warning",
        source: meetingSource,
        message:
          latestMeeting.overdueObligations > 0
            ? `${latestMeeting.openObligations} meeting commitment${latestMeeting.openObligations === 1 ? "" : "s"} remain open, including ${latestMeeting.overdueObligations} overdue.`
            : `${latestMeeting.openObligations} meeting commitment${latestMeeting.openObligations === 1 ? "" : "s"} remain open from the latest meeting.`,
      });
    }

    if (
      latestMeeting.meetingSentiment === "concerned" ||
      latestMeeting.meetingSentiment === "tense"
    ) {
      drivers.push({
        level:
          latestMeeting.meetingSentiment === "tense" ? "critical" : "warning",
        source: meetingSource,
        message: `Latest meeting sentiment was ${latestMeeting.meetingSentiment}.`,
      });
    }

    if (latestMeeting.blockers.length > 0) {
      drivers.push({
        level: "warning",
        source: meetingSource,
        message:
          latestMeeting.blockers.length === 1
            ? `Latest meeting highlighted blocker: ${withTrailingPeriod(latestMeeting.blockers[0])}`
            : `Latest meeting highlighted ${latestMeeting.blockers.length} blockers or risks, including ${withTrailingPeriod(latestMeeting.blockers[0])}`,
      });
    }
  }

  if (drivers.length === 0) {
    if (input.recentActivity.resolvedFollowUps > 0) {
      drivers.push({
        level: "positive",
        source: "slack",
        message: `${input.recentActivity.resolvedFollowUps} follow-up${input.recentActivity.resolvedFollowUps === 1 ? "" : "s"} closed in the last ${input.recentActivity.windowHours} hours.`,
      });
    } else if (
      input.resolutionSignalCount > 0 ||
      input.decisionSignalCount > 0
    ) {
      drivers.push({
        level: "positive",
        source: "slack",
        message: "Recent Slack context shows decisions or resolution progress.",
      });
    } else if (
      latestMeeting &&
      latestMeeting.openObligations === 0 &&
      (latestMeeting.meetingSentiment === "positive" ||
        latestMeeting.meetingSentiment === "neutral" ||
        latestMeeting.meetingSentiment === null)
    ) {
      drivers.push({
        level: "positive",
        source: "fathom",
        message: "Latest meeting closed without tracked open commitments.",
      });
    } else {
      drivers.push({
        level: "positive",
        source: "slack",
        message:
          input.recentActivity.messageCount > 0
            ? `${input.recentActivity.messageCount} recent Slack message${input.recentActivity.messageCount === 1 ? "" : "s"} landed without strong risk pressure.`
            : "Recent channel activity looks steady without strong risk pressure.",
      });
    }
  }

  return dedupeUnifiedDrivers(drivers).slice(0, 5);
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

const scopeEnum = z.enum(["active", "archive", "live"]);

const messagesQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
  scope: scopeEnum.optional().default(PRODUCT_WINDOW_POLICY.defaultScope),
});

const analyticsQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
  emotion: z.enum(["anger", "disgust", "fear", "joy", "neutral", "sadness", "surprise"]).optional(),
  risk: z.enum(["low", "medium", "high", "flagged"]).optional(),
  scope: scopeEnum.optional().default(PRODUCT_WINDOW_POLICY.defaultScope),
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
  scope: scopeEnum.optional().default(PRODUCT_WINDOW_POLICY.defaultScope),
});

const liveMessagesQuery = workspaceQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).optional().default(40),
  group: z.enum(["threaded", "flat"]).optional().default("threaded"),
  participantId: z.string().optional(),
  scope: scopeEnum.optional().default("live"),
});

const threadsQuery = workspaceQuery.extend({
  scope: scopeEnum.optional().default(PRODUCT_WINDOW_POLICY.defaultScope),
});

const rollupBody = z.object({
  mode: z.enum(["channel", "thread", "backfill"]).optional().default("channel"),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatEnrichedMessage(
  m: EnrichedMessageWithAnalyticsRow,
  crucialReasonsByTs: Map<string, string | null> = new Map(),
  truthState: MessageTruthState | null = null,
) {
  const raw = (m.ma_raw_llm_response ?? {}) as Record<string, unknown>;
  const derivedTruth = truthState ?? deriveLegacyMessageTruth({
    analysisStatus: m.analysis_status,
    analysis: m.ma_dominant_emotion ? { emotion: m.ma_dominant_emotion } : null,
  });
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
    analysisEligibility: derivedTruth.analysisEligibility,
    analysisExecution: derivedTruth.analysisExecution,
    analysisQuality: derivedTruth.analysisQuality,
    suppressionReason: derivedTruth.suppressionReason,
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
    const [rows, policies] = await Promise.all([
      db.getAllChannelsWithState(workspaceId, {
        activeWindowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
      }),
      db.listConversationPolicies(workspaceId),
    ]);
    const [healthCountRows, truthSnapshots, sparklineRows, meetingObligationRows] =
      await Promise.all([
        db.getChannelHealthCounts(workspaceId, undefined, {
          windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
        }),
        fetchChannelTruthSnapshots(
          workspaceId,
          rows.map((row) => row.channel_id),
        ),
        db.getChannelSentimentSparklines(
          workspaceId,
          rows
            .filter((row) => row.status === "ready")
            .map((row) => row.channel_id),
          7,
        ),
        db.listMeetingObligationCountsByChannel(
          workspaceId,
          rows.map((row) => row.channel_id),
        ),
      ]);
    const healthCountMap = new Map(healthCountRows.map((h) => [h.channel_id, h]));
    const policyMap = new Map(policies.map((policy) => [policy.channel_id, policy]));
    const meetingObligationCountMap = new Map(
      meetingObligationRows.map((row) => [row.channelId, row]),
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
      const truth = truthSnapshots.get(r.channel_id);
      const meetingObligationCounts = meetingObligationCountMap.get(r.channel_id);
      const riskState = buildChannelRiskState(hc, {
        effectiveChannelMode: channelMode.effectiveChannelMode,
        meetingObligationCounts: meetingObligationCounts
          ? {
              openCount: meetingObligationCounts.openCount,
              overdueCount: meetingObligationCounts.overdueCount,
            }
          : undefined,
      });
      return {
        channelId: r.channel_id,
        name: r.name ?? null,
        status: r.status,
        conversationType: r.conversation_type ?? "public_channel",
        messageCount: Number(r.message_count ?? 0),
        activeMessageCount: Number(r.active_message_count ?? 0),
        totalImportedMessageCount: Number(
          r.total_imported_message_count ?? r.message_count ?? 0,
        ),
        initializedAt: r.initialized_at ?? null,
        lastActivity: r.last_event_at ?? null,
        updatedAt: r.updated_at ?? null,
        ...buildProductWindowPayload(),
        ingestReadiness: truth?.ingestReadiness ?? null,
        intelligenceReadiness: truth?.intelligenceReadiness ?? null,
        latestSummaryCompleteness: truth?.latestSummaryCompleteness ?? null,
        hasActiveDegradations: truth?.hasActiveDegradations ?? false,
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
        signalEvidenceTier: riskState.signalEvidenceTier,
        health: riskState.health,
        effectiveChannelMode: riskState.effectiveChannelMode,
        riskDrivers: riskState.riskDrivers,
        attentionSummary: riskState.attentionSummary,
        messageDispositionCounts: riskState.messageDispositionCounts,
        sparklineData: sparklineMap.get(r.channel_id) ?? [],
      };
    });

    res.json({
      total: channels.length,
      ...buildProductWindowPayload(),
      channels,
    });
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
  const activeWindowStartTs =
    resolveWindowScopeStartTs(PRODUCT_WINDOW_POLICY.defaultScope) ?? null;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found" });
    return;
  }

  const [
    initialState,
    messageCount,
    activeMessageCount,
    participantCounts,
    threads,
    initialHealthCountRows,
    rule,
    meetingObligationCounts,
    recentActivityMetrics,
  ] = await Promise.all([
    db.getChannelState(workspaceId, channelId),
    db.getMessageCount(workspaceId, channelId),
    db.getMessageCountInWindow(
      workspaceId,
      channelId,
      PRODUCT_WINDOW_POLICY.activeWindowDays,
    ),
    db.getChannelParticipantCounts(workspaceId, channelId),
    activeWindowStartTs
      ? db.getActiveThreadsSinceTs(workspaceId, channelId, activeWindowStartTs, 20)
      : db.getThreads(workspaceId, channelId),
    db.getChannelHealthCounts(workspaceId, channelId, {
      windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
    }),
    db.getFollowUpRule(workspaceId, channelId),
    db.getMeetingObligationCounts(workspaceId, channelId),
    db.getRecentChannelActivityMetrics(workspaceId, channelId, 24),
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
      windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
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
      windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
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
      db.getChannelHealthCounts(workspaceId, channelId, {
        windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
      }),
    ]);
    hc = healthCountRows[0];
  }
  if (responseCommitted(res)) {
    return;
  }
  const riskState = buildChannelRiskState(hc, {
    effectiveChannelMode: channelMode.effectiveChannelMode,
    meetingObligationCounts,
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
  const [truth, meetings] = await Promise.all([
    fetchChannelTruthSnapshot(workspaceId, channelId),
    db.listMeetingsForChannel(workspaceId, channelId, 1),
  ]);
  const activeWindowSummary =
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
        });
  const activeWindowSummaryCoverage = buildSummaryCoveragePayload(
    truth.summaryArtifact?.coverageStartTs ?? null,
    truth.summaryArtifact?.coverageEndTs ?? null,
  );
  const activeWindowSummaryUpdatedAt =
    truth.summaryArtifact?.updatedAt?.toISOString() ??
    state?.updated_at?.toISOString() ??
    null;
  const keyDecisions = buildKeyDecisionPayload({
    legacyKeyDecisions: state?.key_decisions_json ?? [],
    summaryFacts: truth.summaryArtifact?.summaryFacts ?? [],
    fallbackDetectedAt: activeWindowSummaryUpdatedAt,
  });
  const liveSummary = state?.live_summary?.trim() ?? "";
  const liveSummaryCoverage = buildSummaryCoveragePayload(
    state?.live_summary_source_ts_start ?? null,
    state?.live_summary_source_ts_end ?? null,
  );
  const visibleLiveSummary = shouldExposeLiveSummary({
    summary: liveSummary,
    coverageEndTs: state?.live_summary_source_ts_end ?? null,
    activeCoverageEndTs: truth.summaryArtifact?.coverageEndTs ?? null,
  })
    ? liveSummary
    : null;
  const activeWindowStartAt = parseSlackTsToDate(activeWindowStartTs);
  const latestMeeting = meetings[0] ?? null;
  const latestMeetingObligations = latestMeeting
    ? await db.getMeetingObligations(workspaceId, latestMeeting.id)
    : [];
  const candidateMeetingContext = latestMeeting
    ? buildMeetingContext(latestMeeting, latestMeetingObligations)
    : null;
  const meetingContext =
    candidateMeetingContext &&
    shouldIncludeMeetingContext(candidateMeetingContext, activeWindowStartAt)
      ? candidateMeetingContext
      : null;
  const recentActivity: RecentActivityPayload = {
    label: "Recent activity",
    windowHours: recentActivityMetrics.windowHours,
    messageCount: recentActivityMetrics.messageCount,
    activeThreads: recentActivityMetrics.activeThreads,
    openFollowUps: recentActivityMetrics.openFollowUps,
    resolvedFollowUps: recentActivityMetrics.resolvedFollowUps,
  };
  const unifiedDrivers = buildUnifiedDrivers({
    signal: riskState.signal,
    riskDrivers: riskState.riskDrivers,
    recentActivity,
    meetingContext,
    resolutionSignalCount: riskState.healthCounts.resolutionSignalCount,
    decisionSignalCount: riskState.healthCounts.decisionSignalCount,
  });
  res.status(200).json({
    channelId: channel.channel_id,
    channelName: channel.name ?? channel.channel_id,
    conversationType: channel.conversation_type ?? "public_channel",
    status: channel.status,
    ...buildProductWindowPayload(),
    importanceTierOverride: importance.importanceTierOverride,
    recommendedImportanceTier: importance.recommendedImportanceTier,
    effectiveImportanceTier: importance.effectiveImportanceTier,
    channelModeOverride: channelMode.channelModeOverride,
    recommendedChannelMode: channelMode.recommendedChannelMode,
    effectiveChannelMode: channelMode.effectiveChannelMode,
    initializedAt: channel.initialized_at,
    updatedAt: channel.updated_at,
    lastEventAt: channel.last_event_at,
    ingestReadiness: truth.ingestReadiness,
    intelligenceReadiness: truth.intelligenceReadiness,
    latestSummaryCompleteness: truth.latestSummaryCompleteness,
    hasActiveDegradations: truth.hasActiveDegradations,
    currentSummaryArtifactId: truth.currentSummaryArtifactId,
    activeBackfillRunId: truth.activeBackfillRunId,
    activeWindowSummary,
    activeWindowSummaryUpdatedAt,
    activeWindowSummaryCoverage,
    runningSummary: activeWindowSummary,
    liveSummary: visibleLiveSummary,
    liveSummaryUpdatedAt:
      visibleLiveSummary && state?.live_summary_updated_at
        ? state.live_summary_updated_at.toISOString()
        : null,
    liveSummaryCoverage: visibleLiveSummary ? liveSummaryCoverage : null,
    keyDecisions,
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
    signalEvidenceTier: riskState.signalEvidenceTier,
    health: riskState.health,
    riskDrivers: riskState.riskDrivers,
    recentActivity,
    meetingContext,
    unifiedDrivers,
    attentionSummary: riskState.attentionSummary,
    messageDispositionCounts: riskState.messageDispositionCounts,
    summaryArtifact: truth.summaryArtifact,
    backfillRun: truth.backfillRun,
    degradationSignals: truth.degradationSignals,
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
    activeMessageCount,
    totalImportedMessageCount: messageCount,
    messageCount,
  });
});

channelsRouter.get("/:channelId/diagnostics", async (req, res) => {
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

  try {
    const [truth, counts] = await Promise.all([
      fetchChannelTruthSnapshot(workspaceId, channelId),
      fetchChannelTruthCounts(workspaceId, channelId),
    ]);

    res.status(200).json({
      channelId: channel.channel_id,
      channelName: channel.name ?? channel.channel_id,
      status: channel.status,
      ingestReadiness: truth.ingestReadiness,
      intelligenceReadiness: truth.intelligenceReadiness,
      latestSummaryCompleteness: truth.latestSummaryCompleteness,
      hasActiveDegradations: truth.hasActiveDegradations,
      currentSummaryArtifactId: truth.currentSummaryArtifactId,
      activeBackfillRunId: truth.activeBackfillRunId,
      summaryArtifact: truth.summaryArtifact,
      backfillRun: truth.backfillRun,
      degradationSignals: truth.degradationSignals,
      messageTruthCounts: counts,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error({ err, channelId, workspaceId }, "Failed to fetch channel diagnostics");
    res.status(500).json({
      error: "diagnostics_failed",
      message: "Failed to fetch channel diagnostics",
      requestId: req.id,
    });
  }
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
  const scope = normalizeProductWindowScope(query.data.scope);
  const scopeStartTs = resolveWindowScopeStartTs(scope);

  if (threadTs) {
    const [threadMessages, threadInsight] = await Promise.all([
      db.getMessagesEnriched(workspaceId, channelId, {
        limit,
        threadTs,
        afterTs: scopeStartTs,
      }),
      db.getThreadInsight(workspaceId, channelId, threadTs),
    ]);
    const crucialReasonsByTs = buildCrucialReasonLookup(threadInsight);
    const truthMap = await fetchMessageTruthStates(
      workspaceId,
      channelId,
      threadMessages.map((message) => message.ts),
    );
    res.status(200).json({
      channelId,
      threadTs,
      scope,
      ...buildProductWindowPayload(scope),
      total: threadMessages.length,
      returned: threadMessages.length,
      messages: threadMessages.map((message) =>
        formatEnrichedMessage(
          message,
          crucialReasonsByTs,
          truthMap.get(message.ts) ?? null,
        ),
      ),
      threadInsight: threadInsightPayload(threadInsight),
    });
    return;
  }

  const topMessages = await db.getTopLevelMessagesEnriched(workspaceId, channelId, {
    limit,
    afterTs: scopeStartTs,
  });

  const threadsToFetch = topMessages.filter((m) => m.reply_count > 0);
  const repliesMap = new Map<string, Awaited<ReturnType<typeof db.getThreadRepliesEnriched>>>();

  await Promise.all(
    threadsToFetch.map(async (m) => {
      const replies = await db.getThreadRepliesEnriched(workspaceId, channelId, m.ts);
      repliesMap.set(m.ts, replies);
    }),
  );
  const truthMap = await fetchMessageTruthStates(
    workspaceId,
    channelId,
    [
      ...topMessages.map((message) => message.ts),
      ...threadsToFetch.flatMap((message) =>
        (repliesMap.get(message.ts) ?? []).map((reply) => reply.ts),
      ),
    ],
  );

  const formatted = topMessages.map((m) => {
    const replies = repliesMap.get(m.ts) ?? [];
    return {
      ...formatEnrichedMessage(m, new Map(), truthMap.get(m.ts) ?? null),
      replyCount: m.reply_count,
      replies: replies.map((r) =>
        formatEnrichedMessage(r, new Map(), truthMap.get(r.ts) ?? null),
      ),
    };
  });

  res.status(200).json({
    channelId,
    scope,
    ...buildProductWindowPayload(scope),
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
  const query = threadsQuery.safeParse(req.query);
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

  const scope = normalizeProductWindowScope(query.data.scope);
  const scopeStartTs = resolveWindowScopeStartTs(scope);
  const threads =
    scopeStartTs
      ? await db.getActiveThreadsSinceTs(workspaceId, channelId, scopeStartTs, 50)
      : await db.getThreads(workspaceId, channelId, 50);
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
        afterTs: scopeStartTs,
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
    scope,
    ...buildProductWindowPayload(scope),
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
  const scope = normalizeProductWindowScope(query.data.scope);
  const scopeStartTs = resolveWindowScopeStartTs(scope);

  const rows = await db.getMessageAnalytics(workspaceId, channelId, {
    limit,
    offset,
    threadTs: query.data.threadTs ?? null,
    emotion: query.data.emotion ?? null,
    risk: query.data.risk ?? null,
    afterTs: scopeStartTs,
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
      scope,
    },
    analytics,
    scope,
    ...buildProductWindowPayload(scope),
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
    const scope = normalizeProductWindowScope(query.data.scope);
    const scopeStartTs = resolveWindowScopeStartTs(scope);
    const defaultFrom =
      !query.data.from && scopeStartTs
        ? new Date(Number.parseFloat(scopeStartTs) * 1000).toISOString()
        : null;
    const buckets = await db.getSentimentTrends(workspaceId, {
      channelId,
      granularity: query.data.granularity,
      from: query.data.from ?? defaultFrom,
      to: query.data.to ?? null,
      limit: query.data.limit,
    });

    res.json({
      channelId,
      scope,
      ...buildProductWindowPayload(scope),
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
    const scope = normalizeProductWindowScope(query.data.scope, "live");
    const scopeStartTs = resolveWindowScopeStartTs(scope);
    const rows = await db.getMessagesEnriched(workspaceId, channelId, {
      limit: query.data.limit,
      participantId: query.data.participantId ?? null,
      afterTs: scopeStartTs,
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
    let allRows = [...rows];
    if (query.data.group === "threaded" && !query.data.participantId) {
      const grouped = new Map<
        string,
        {
          latestTs: number;
          messages: EnrichedMessageWithAnalyticsRow[];
        }
      >();

      for (const row of rows) {
        const threadKey = row.thread_ts ?? row.ts;
        const existing = grouped.get(threadKey) ?? { latestTs: 0, messages: [] };
        existing.messages.push(row);
        existing.latestTs = Math.max(existing.latestTs, Number.parseFloat(row.ts));
        grouped.set(threadKey, existing);
      }

      const missingRootTs = [...grouped.entries()]
        .filter(([threadKey, group]) => threadKey !== group.messages[0]?.ts)
        .filter(([threadKey, group]) => !group.messages.some((message) => message.ts === threadKey))
        .map(([threadKey]) => threadKey);

      if (missingRootTs.length > 0 && !scopeStartTs) {
        const rootRows = await db.getMessagesEnrichedByTs(workspaceId, channelId, missingRootTs);
        allRows = [...rows, ...rootRows];
        for (const rootRow of rootRows) {
          const group = grouped.get(rootRow.ts);
          if (!group) continue;
          group.messages.push(rootRow);
        }
      }

      const truthMap = await fetchMessageTruthStates(
        workspaceId,
        channelId,
        allRows.map((message) => message.ts),
      );

      const formattedGroups = [...grouped.values()]
        .map((group) => ({
          latestTs: group.latestTs,
          messages: group.messages.map((row) =>
            formatEnrichedMessage(
              row,
              resolveCrucialReasons(row.thread_ts ?? row.ts),
              truthMap.get(row.ts) ?? null,
            ),
          ),
        }))
        .sort((left, right) => right.latestTs - left.latestTs);

      const messages = formattedGroups.flatMap((group) =>
        [...group.messages].sort(
          (left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts),
        ),
      );

      res.json({
        channelId,
        scope,
        ...buildProductWindowPayload(scope),
        total: messages.length,
        returned: messages.length,
        messages,
      });
      return;
    }

    const truthMap = await fetchMessageTruthStates(
      workspaceId,
      channelId,
      allRows.map((message) => message.ts),
    );
    const messages = allRows
      .map((row) =>
        formatEnrichedMessage(
          row,
          resolveCrucialReasons(row.thread_ts ?? row.ts),
          truthMap.get(row.ts) ?? null,
        ),
      )
      .sort((left, right) => Number.parseFloat(right.ts) - Number.parseFloat(left.ts));

    res.json({
      channelId,
      scope,
      ...buildProductWindowPayload(scope),
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

  const summary = await db.getChannelSummary(workspaceId, channelId, {
    windowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
  });
  if (!summary) {
    res.status(404).json({ error: "channel_state_not_found", requestId: req.id });
    return;
  }

  res.status(200).json({
    channelId,
    ...buildProductWindowPayload(),
    ...summary,
  });
});

// ─── Channel Classification ──────────────────────────────────────────────────

channelsRouter.get("/:channelId/classification", requireServiceAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const channelId = String(req.params.channelId);
    if (!workspaceId) { res.status(400).json({ error: "workspace_id required" }); return; }

    const classification = await db.getChannelClassification(workspaceId, channelId);
    if (!classification) {
      res.status(200).json({ channelId, channelType: "unclassified", confidence: 0, classificationSource: null });
      return;
    }

    res.status(200).json({
      channelId,
      channelType: classification.channel_type,
      confidence: classification.confidence,
      classificationSource: classification.classification_source,
      clientName: classification.client_name,
      topics: classification.topics_json,
      reasoning: classification.reasoning,
      classifiedAt: classification.classified_at,
      overriddenAt: classification.overridden_at,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to get channel classification");
    res.status(500).json({ error: "internal_error" });
  }
});

channelsRouter.put("/:channelId/classification", requireServiceAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const channelId = String(req.params.channelId);
    if (!workspaceId) { res.status(400).json({ error: "workspace_id required" }); return; }

    const { channel_type, client_name } = req.body ?? {};
    const validTypes = ["client_delivery", "client_support", "internal_engineering", "internal_operations", "internal_social", "automated"];
    if (!channel_type || !validTypes.includes(channel_type)) {
      res.status(400).json({ error: `channel_type must be one of: ${validTypes.join(", ")}` });
      return;
    }

    const result = await db.overrideChannelClassification(workspaceId, channelId, channel_type, client_name);

    res.status(200).json({
      channelId,
      channelType: result.channel_type,
      confidence: result.confidence,
      classificationSource: result.classification_source,
      overriddenAt: result.overridden_at,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to override channel classification");
    res.status(500).json({ error: "internal_error" });
  }
});

channelsRouter.get("/classifications/list", requireServiceAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "workspace_id required" }); return; }

    const classifications = await db.listChannelClassifications(workspaceId);
    res.status(200).json({
      classifications: classifications.map((c) => ({
        channelId: c.channel_id,
        channelType: c.channel_type,
        confidence: c.confidence,
        classificationSource: c.classification_source,
        clientName: c.client_name,
        topics: c.topics_json,
        classifiedAt: c.classified_at,
      })),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to list channel classifications");
    res.status(500).json({ error: "internal_error" });
  }
});
