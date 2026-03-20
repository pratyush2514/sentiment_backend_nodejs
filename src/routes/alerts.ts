import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { resolveSurfaceAnalysis } from "../services/analysisSurface.js";
import { resolveConversationImportance } from "../services/conversationImportance.js";
import { emitFollowUpAlert } from "../services/followUpEvents.js";
import { clearFollowUpReminderDms } from "../services/followUpReminderDms.js";
import { isManagerRelevantThreadInsight } from "../services/threadInsightPolicy.js";
import type { EnrichedMessageWithAnalyticsRow } from "../types/database.js";

export const alertsRouter = Router();

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

const alertsQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
  channel_id: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const alertContextQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
  channel_id: z.string().min(1).max(100),
  source_message_ts: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format"),
  thread_ts: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
});

const followUpItemParam = z.object({
  itemId: z.string().uuid(),
});

const followUpActionBody = z.object({
  action: z.enum(["resolve", "dismiss", "snooze", "acknowledge_waiting", "reopen"]),
  snoozeHours: z.coerce.number().int().min(1).max(24 * 14).optional(),
});

function nowSlackTs(): string {
  return (Date.now() / 1000).toFixed(6);
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
) {
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

function severityWeight(severity: string): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function followUpTitle(workflowState: string, dueAt: Date): string {
  if (workflowState === "acknowledged_waiting") {
    return "Acknowledged, waiting on completion";
  }
  if (workflowState === "escalated") {
    return "Escalated follow-up";
  }
  if (dueAt.getTime() <= Date.now()) {
    return "Reply overdue";
  }
  return "Reply needed";
}

function formatAnalysis(row: EnrichedMessageWithAnalyticsRow) {
  if (!row.ma_dominant_emotion) return null;
  const raw = row.ma_raw_llm_response as Record<string, unknown> | null;
  const surfaced = resolveSurfaceAnalysis({
    dominantEmotion: row.ma_dominant_emotion,
    interactionTone: row.ma_interaction_tone,
    rawInteractionTone:
      typeof raw?.interaction_tone === "string" ? raw.interaction_tone : null,
    escalationRisk: row.ma_escalation_risk ?? "low",
    sarcasmDetected: Boolean(raw?.sarcasm_detected),
    messageText: row.text,
  });
  return {
    emotion: surfaced.emotion,
    interactionTone: surfaced.interactionTone,
    confidence: row.ma_confidence,
    escalationRisk: row.ma_escalation_risk,
    explanation: surfaced.explanationOverride ?? row.ma_explanation ?? null,
    sarcasmDetected: raw?.sarcasm_detected ?? false,
    themes: row.ma_themes ?? [],
    intendedEmotion: raw?.intended_emotion ?? null,
    triggerPhrases: Array.isArray(raw?.trigger_phrases) ? raw.trigger_phrases : [],
    behavioralPattern:
      typeof raw?.behavioral_pattern === "string" ? raw.behavioral_pattern : null,
    messageIntent: row.ma_message_intent ?? null,
    isActionable: row.ma_is_actionable ?? null,
    isBlocking: row.ma_is_blocking ?? false,
    urgencyLevel: row.ma_urgency_level ?? "none",
  };
}

function resolveStrictAnalysisStatus(row: EnrichedMessageWithAnalyticsRow) {
  if (row.analysis_status === "completed" && !row.ma_dominant_emotion) {
    return "pending" as const;
  }

  return row.analysis_status;
}

function toSlackIso(ts: string | null | undefined, fallback?: Date | string | null): string | null {
  if (ts) {
    const parsed = Number.parseFloat(ts);
    if (Number.isFinite(parsed)) {
      return new Date(parsed * 1000).toISOString();
    }
  }

  if (fallback instanceof Date) {
    return fallback.toISOString();
  }
  if (typeof fallback === "string") {
    return fallback;
  }

  return null;
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

function allowsLowValueThreadInsight(insight: {
  thread_state: string;
  operational_risk: string;
  surface_priority: string;
}): boolean {
  return (
    insight.thread_state === "blocked" ||
    insight.thread_state === "escalated" ||
    insight.operational_risk === "high" ||
    insight.surface_priority === "high"
  );
}

function allowsLowValueSentimentAlert(alert: {
  escalation_risk: string;
}): boolean {
  return alert.escalation_risk === "high";
}

alertsRouter.get("/", async (req, res) => {
  const query = alertsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const channelIdFilter = query.data.channel_id ?? null;
  const limit = query.data.limit;

  const [followUps, sentimentAlerts, recentThreadInsights, policies] = await Promise.all([
    db.listOpenFollowUpItems(workspaceId, limit),
    db.getRecentSentimentAlerts(workspaceId, limit),
    db.getRecentThreadInsights(workspaceId, limit),
    db.listConversationPolicies(workspaceId),
  ]);
  const policyMap = new Map(policies.map((policy) => [policy.channel_id, policy]));
  const coveredThreads = new Set(
    recentThreadInsights
      .filter((insight) => insight.surface_priority === "medium" || insight.surface_priority === "high")
      .map((insight) => insight.thread_ts),
  );

  const alerts = [
    ...followUps
      .filter((item) => {
        if (channelIdFilter && item.channel_id !== channelIdFilter) {
          return false;
        }
        const policy = policyMap.get(item.channel_id);
        const conversationType =
          (policy?.conversation_type ?? item.conversation_type ?? "public_channel") as
            | "public_channel"
            | "private_channel"
            | "dm"
            | "group_dm";
        const privacyAllowed =
          conversationType === "public_channel" || Boolean(policy?.privacy_opt_in);
        return privacyAllowed && !policy?.muted && policy?.enabled !== false;
      })
      .map((item) => ({
      id: `follow-up:${item.id}`,
      kind: "follow_up" as const,
      followUpItemId: item.id,
      channelId: item.channel_id,
      channelName: item.channel_name ?? item.channel_id,
      conversationType: (item.conversation_type ?? "public_channel") as
        | "public_channel"
        | "private_channel"
        | "dm"
        | "group_dm",
      severity: item.seriousness,
      title: followUpTitle(item.workflow_state, item.due_at),
      message: item.summary || item.source_message_text || "A requester is waiting for a reply.",
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      actorName:
        item.requester_display_name ??
        item.requester_real_name ??
        item.requester_user_id,
      dueAt: item.due_at,
      createdAt: item.created_at,
      contextHref: item.source_thread_ts
        ? `/dashboard/channels/${item.channel_id}/threads/${item.source_thread_ts}?messageTs=${item.source_message_ts}#message-${item.source_message_ts.replace(".", "-")}`
        : `/dashboard/channels/${item.channel_id}?conversation=1&messageTs=${item.source_message_ts}`,
      metadata: {
        repeatedAskCount: item.repeated_ask_count,
        alertCount: item.alert_count,
      },
    })),
    ...recentThreadInsights
      .filter((insight) => {
        if (channelIdFilter && insight.channel_id !== channelIdFilter) {
          return false;
        }
        const policy = policyMap.get(insight.channel_id);
        const conversationType = policy?.conversation_type ?? insight.conversation_type ?? "public_channel";
        const importance = resolveConversationImportance({
          channelName: insight.channel_name ?? insight.channel_id,
          conversationType,
          clientUserIds: policy?.client_user_ids ?? [],
          importanceTierOverride: policy?.importance_tier_override,
        });
        const privacyAllowed =
          conversationType === "public_channel" || Boolean(policy?.privacy_opt_in);
        return (
          privacyAllowed &&
          !policy?.muted &&
          policy?.enabled !== false &&
          (
            importance.effectiveImportanceTier !== "low_value" ||
            allowsLowValueThreadInsight(insight)
          ) &&
          isManagerRelevantThreadInsight({
            threadState: insight.thread_state,
            operationalRisk: insight.operational_risk,
            emotionalTemperature: insight.emotional_temperature,
            surfacePriority: insight.surface_priority,
            openQuestions: insight.open_questions_json,
            crucialMoments: insight.crucial_moments_json,
          })
        );
      })
      .map((insight) => ({
        id: `thread-insight:${insight.channel_id}:${insight.thread_ts}`,
        kind: "sentiment" as const,
        channelId: insight.channel_id,
        channelName: insight.channel_name ?? insight.channel_id,
        conversationType: (insight.conversation_type ?? "public_channel") as
          | "public_channel"
          | "private_channel"
          | "dm"
          | "group_dm",
        severity:
          insight.surface_priority === "high" || insight.operational_risk === "high" || insight.thread_state === "escalated"
            ? "high"
            : "medium",
        title:
          insight.thread_state === "blocked"
            ? "Blocked thread requires attention"
            : "Crucial thread moment surfaced",
        message: insight.summary,
        sourceMessageTs: insight.last_meaningful_change_ts ?? insight.thread_ts,
        threadTs: insight.thread_ts,
        actorName: null,
        dueAt: null,
        createdAt: insight.updated_at,
        contextHref:
          `/dashboard/channels/${insight.channel_id}/threads/${insight.thread_ts}?messageTs=${(insight.last_meaningful_change_ts ?? insight.thread_ts)}#message-${(insight.last_meaningful_change_ts ?? insight.thread_ts).replace(".", "-")}`,
        metadata: {
          threadState: insight.thread_state,
          surfaceReason: insight.primary_issue,
          primaryIssue: insight.primary_issue,
          emotionalTemperature: insight.emotional_temperature,
          operationalRisk: insight.operational_risk,
        },
      })),
    ...sentimentAlerts
      .filter((item) => !item.thread_ts || !coveredThreads.has(item.thread_ts))
      .filter((item) => {
        if (channelIdFilter && item.channel_id !== channelIdFilter) {
          return false;
        }
        const policy = policyMap.get(item.channel_id);
        const conversationType =
          (policy?.conversation_type ?? item.conversation_type ?? "public_channel") as
            | "public_channel"
            | "private_channel"
            | "dm"
            | "group_dm";
        const importance = resolveConversationImportance({
          channelName: item.channel_name ?? item.channel_id,
          conversationType,
          clientUserIds: policy?.client_user_ids ?? [],
          importanceTierOverride: policy?.importance_tier_override,
        });
        const privacyAllowed =
          conversationType === "public_channel" || Boolean(policy?.privacy_opt_in);
        return (
          privacyAllowed &&
          !policy?.muted &&
          (
            importance.effectiveImportanceTier !== "low_value" ||
            allowsLowValueSentimentAlert(item)
          )
        );
      })
      .map((item) => {
        const surfaced = resolveSurfaceAnalysis({
          dominantEmotion: item.dominant_emotion,
          interactionTone: item.interaction_tone,
          escalationRisk: item.escalation_risk,
          sarcasmDetected: false,
          messageText: item.message_text,
        });

        if (
          surfaced.emotion === "neutral" &&
          item.escalation_risk !== "high" &&
          (surfaced.interactionTone === "corrective" || surfaced.interactionTone === "tense")
        ) {
          return null;
        }

        return {
          id: `sentiment:${item.channel_id}:${item.message_ts}`,
          kind: "sentiment" as const,
          channelId: item.channel_id,
          channelName: item.channel_name ?? item.channel_id,
          conversationType: (item.conversation_type ?? "public_channel") as
            | "public_channel"
            | "private_channel"
            | "dm"
            | "group_dm",
          severity: item.escalation_risk === "high" ? "high" : "medium",
          title:
            item.escalation_risk === "high"
              ? "High escalation risk"
              : "Elevated sentiment risk",
          message:
            surfaced.explanationOverride ??
            item.explanation ??
            item.message_text ??
            "Recent conversation needs attention.",
          sourceMessageTs: item.message_ts,
          threadTs: item.thread_ts,
          actorName: item.display_name ?? item.real_name ?? item.user_id ?? "Unknown",
          dueAt: null,
          createdAt: item.created_at,
          contextHref: item.thread_ts
            ? `/dashboard/channels/${item.channel_id}/threads/${item.thread_ts}?messageTs=${item.message_ts}#message-${item.message_ts.replace(".", "-")}`
            : `/dashboard/channels/${item.channel_id}?conversation=1&messageTs=${item.message_ts}`,
          metadata: {
            emotion: surfaced.emotion,
            interactionTone: surfaced.interactionTone,
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
  ]
    .sort((a, b) => {
      const severityDelta = severityWeight(b.severity) - severityWeight(a.severity);
      if (severityDelta !== 0) return severityDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, limit);

  res.status(200).json({
    total: alerts.length,
    alerts,
  });
});

alertsRouter.post("/follow-ups/:itemId/action", async (req, res) => {
  const params = followUpItemParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }

  const query = alertsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const body = followUpActionBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const item = await db.getFollowUpItem(workspaceId, params.data.itemId);

  if (!item) {
    res.status(404).json({ error: "follow_up_not_found", requestId: req.id });
    return;
  }

  if (item.status !== "open") {
    res.status(200).json({
      itemId: item.id,
      status: item.status,
      action: body.data.action,
    });
    return;
  }

  if (body.data.action === "resolve") {
    await clearFollowUpReminderDms(workspaceId, item.id);
    await db.resolveFollowUpItemManually(item.id, req.userId ?? null);
    await db.recordFollowUpEvent({
      followUpItemId: item.id,
      workspaceId,
      channelId: item.channel_id,
      eventType: "resolved",
      workflowState: "resolved",
      actorUserId: req.userId ?? null,
    });
    emitFollowUpAlert({
      workspaceId,
      channelId: item.channel_id,
      followUpItemId: item.id,
      alertType: "follow_up_resolved",
      changeType: "resolved",
      seriousness: item.seriousness,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
    });
  } else if (body.data.action === "dismiss") {
    await clearFollowUpReminderDms(workspaceId, item.id);
    await db.dismissFollowUpItem(item.id, req.userId ?? null);
    await db.recordFollowUpEvent({
      followUpItemId: item.id,
      workspaceId,
      channelId: item.channel_id,
      eventType: "dismissed",
      workflowState: "dismissed",
      actorUserId: req.userId ?? null,
    });
    emitFollowUpAlert({
      workspaceId,
      channelId: item.channel_id,
      followUpItemId: item.id,
      alertType: "follow_up_dismissed",
      changeType: "dismissed",
      seriousness: item.seriousness,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
    });
  } else if (body.data.action === "snooze") {
    const snoozeHours = body.data.snoozeHours ?? 24;
    const snoozedUntil = new Date(Date.now() + snoozeHours * 60 * 60 * 1000);
    await clearFollowUpReminderDms(workspaceId, item.id);
    await db.snoozeFollowUpItem(item.id, snoozedUntil);
    await db.recordFollowUpEvent({
      followUpItemId: item.id,
      workspaceId,
      channelId: item.channel_id,
      eventType: "snoozed",
      workflowState: item.workflow_state,
      actorUserId: req.userId ?? null,
      metadata: {
        snoozedUntil: snoozedUntil.toISOString(),
      },
    });
    emitFollowUpAlert({
      workspaceId,
      channelId: item.channel_id,
      followUpItemId: item.id,
      alertType: "follow_up_snoozed",
      changeType: "snoozed",
      seriousness: item.seriousness,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      summary: `Reminder snoozed for ${snoozeHours}h.`,
    });
  } else if (body.data.action === "acknowledge_waiting") {
    const dueAt = new Date(
      Date.now() +
        Math.min(12, Number(item.metadata_json?.["configuredSlaHours"] ?? 12)) *
          60 *
          60 *
          1000,
    );
    await clearFollowUpReminderDms(workspaceId, item.id);
    await db.markFollowUpWaiting({
      itemId: item.id,
      dueAt,
      acknowledgedByUserId: req.userId ?? null,
    });
    await db.recordFollowUpEvent({
      followUpItemId: item.id,
      workspaceId,
      channelId: item.channel_id,
      eventType: "acknowledged",
      workflowState: "acknowledged_waiting",
      actorUserId: req.userId ?? null,
      metadata: {
        dueAt: dueAt.toISOString(),
      },
    });
    emitFollowUpAlert({
      workspaceId,
      channelId: item.channel_id,
      followUpItemId: item.id,
      alertType: "follow_up_acknowledged",
      changeType: "acknowledged",
      seriousness: item.seriousness,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      summary: "Acknowledged, waiting on completion.",
    });
  } else {
    const state =
      item.workflow_state === "acknowledged_waiting" &&
      item.escalation_responder_ids.length > 0
        ? "escalated"
        : "awaiting_primary";
    const dueAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const nowTs = nowSlackTs();
    await clearFollowUpReminderDms(workspaceId, item.id);
    await db.reopenFollowUpItem({
      itemId: item.id,
      lastRequestTs: nowTs,
      seriousness: item.seriousness,
      seriousnessScore: item.seriousness_score,
      reasonCodes: item.reason_codes,
      summary: item.summary,
      workflowState: state,
      dueAt,
      visibilityAfter: new Date(),
      nextExpectedResponseAt: dueAt,
    });
    await db.recordFollowUpEvent({
      followUpItemId: item.id,
      workspaceId,
      channelId: item.channel_id,
      eventType: state === "escalated" ? "escalated" : "reopened",
      workflowState: state,
      actorUserId: req.userId ?? null,
      messageTs: nowTs,
    });
    emitFollowUpAlert({
      workspaceId,
      channelId: item.channel_id,
      followUpItemId: item.id,
      alertType: state === "escalated" ? "follow_up_escalated" : "follow_up_opened",
      changeType: state === "escalated" ? "escalated" : "reopened",
      seriousness: item.seriousness,
      sourceMessageTs: item.source_message_ts,
      threadTs: item.source_thread_ts,
      summary:
        state === "escalated"
          ? "This follow-up was reopened directly into senior escalation."
          : "This follow-up was reopened and is awaiting a fresh reply.",
    });
  }

  res.status(200).json({
    itemId: item.id,
    status:
      body.data.action === "resolve"
        ? "resolved"
        : body.data.action === "dismiss"
          ? "dismissed"
          : "open",
    action: body.data.action,
  });
});

alertsRouter.get("/context", async (req, res) => {
  const query = alertContextQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const channelId = query.data.channel_id;
  const sourceMessageTs = query.data.source_message_ts;
  const threadTs = query.data.thread_ts ?? null;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const [rows, threadInsight] = await Promise.all([
    threadTs
      ? db.getMessagesEnriched(workspaceId, channelId, { limit: 50, threadTs })
      : db.getTopLevelMessagesAroundTsEnriched(workspaceId, channelId, sourceMessageTs),
    threadTs
      ? db.getThreadInsight(workspaceId, channelId, threadTs)
      : Promise.resolve(null),
  ]);
  const crucialMessageTs = new Set(
    (threadInsight?.crucial_moments_json ?? []).map((moment) => moment.messageTs),
  );

  res.status(200).json({
    channelId,
    channelName: channel.name ?? channel.channel_id,
    sourceMessageTs,
    threadTs,
    total: rows.length,
    returned: rows.length,
    messages: rows.map((row) => ({
      ts: row.ts,
      userId: row.user_id,
      displayName: row.display_name ?? row.real_name ?? row.user_id,
      text: row.text,
      threadTs: row.thread_ts ?? undefined,
      source: row.source,
      analysisStatus: resolveStrictAnalysisStatus(row),
      createdAt: toSlackIso(row.ts, row.created_at),
      analysis: formatAnalysis(row),
      triage: row.mt_candidate_kind
        ? {
            candidateKind: row.mt_candidate_kind,
            signalType: row.mt_signal_type ?? null,
            severity: row.mt_severity ?? "none",
            stateImpact: row.mt_state_impact ?? "none",
            evidenceType: row.mt_evidence_type ?? null,
            channelMode: row.mt_channel_mode ?? null,
            originType: row.mt_origin_type ?? null,
            confidence: row.mt_confidence ?? null,
            incidentFamily: row.mt_incident_family ?? "none",
            surfacePriority: row.mt_surface_priority ?? "none",
            reasonCodes: row.mt_reason_codes ?? [],
            stateTransition: row.mt_state_transition ?? null,
            relatedIncident: buildRelatedIncidentPayload(row.mt_signals_json),
          }
        : null,
      isCrucial: crucialMessageTs.has(row.ts),
      followUp: row.fu_id
        ? {
            itemId: row.fu_id,
            seriousness: row.fu_seriousness,
            summary: row.fu_summary ?? "",
            dueAt: row.fu_due_at instanceof Date ? row.fu_due_at.toISOString() : row.fu_due_at,
            repeatedAskCount: row.fu_repeated_ask_count ?? 1,
          }
        : null,
    })),
    crucialMessages: rows
      .filter((row) => crucialMessageTs.has(row.ts))
      .map((row) => ({
        ts: row.ts,
        userId: row.user_id,
        displayName: row.display_name ?? row.real_name ?? row.user_id,
        text: row.text,
        threadTs: row.thread_ts ?? undefined,
        source: row.source,
        analysisStatus: resolveStrictAnalysisStatus(row),
        createdAt: toSlackIso(row.ts, row.created_at),
        analysis: formatAnalysis(row),
      })),
    threadInsight: threadInsightPayload(threadInsight),
  });
});
