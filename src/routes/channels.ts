import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { enqueueBackfill, enqueueLLMAnalyze } from "../queue/boss.js";
import { logger } from "../utils/logger.js";

export const channelsRouter = Router();

const log = logger.child({ route: "channels" });

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
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
  emotion: z.enum(["anger", "disgust", "fear", "joy", "neutral", "sadness", "surprise"]).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
});

const backfillBody = z.object({
  reason: z.string().max(200).optional().default("manual_trigger"),
});

const analyzeBody = z.object({
  mode: z.enum(["channel", "thread"]).optional().default("channel"),
  threadTs: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format").optional(),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found" });
    return;
  }

  const state = await db.getChannelState(workspaceId, channelId);
  const messageCount = await db.getMessageCount(workspaceId, channelId);
  const threads = await db.getThreads(workspaceId, channelId);

  // Enrich participants with display names
  const participantsRaw = (state?.participants_json ?? {}) as Record<string, number>;
  const userIds = Object.keys(participantsRaw);
  const profiles = await db.getUserProfiles(workspaceId, userIds);
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));

  const participants = userIds
    .map((userId) => {
      const profile = profileMap.get(userId);
      return {
        userId,
        displayName: profile?.display_name ?? profile?.real_name ?? userId,
        messageCount: participantsRaw[userId],
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);

  res.status(200).json({
    channelId: channel.channel_id,
    status: channel.status,
    initializedAt: channel.initialized_at,
    updatedAt: channel.updated_at,
    lastEventAt: channel.last_event_at,
    runningSummary: state?.running_summary ?? "",
    keyDecisions: state?.key_decisions_json ?? [],
    sentimentSnapshot: state?.sentiment_snapshot_json ?? {},
    participants,
    activeThreads: threads.map((t) => ({
      threadTs: t.thread_ts,
      replyCount: t.reply_count,
      lastActivity: t.last_activity,
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const limit = query.data.limit;
  const threadTs = query.data.threadTs ?? null;

  // If threadTs is specified, return flat thread messages (for drilling into a thread)
  if (threadTs) {
    const threadMessages = await db.getMessagesEnriched(workspaceId, channelId, { limit, threadTs });
    res.status(200).json({
      channelId,
      threadTs,
      total: threadMessages.length,
      returned: threadMessages.length,
      messages: threadMessages.map((m) => ({
        ts: m.ts,
        userId: m.user_id,
        displayName: m.display_name ?? m.real_name ?? m.user_id,
        text: m.text,
        threadTs: m.thread_ts,
        source: m.source,
        analysisStatus: m.analysis_status,
        createdAt: m.created_at,
      })),
    });
    return;
  }

  // Default: top-level messages with nested thread replies
  const topMessages = await db.getTopLevelMessagesEnriched(workspaceId, channelId, limit);

  // Fetch thread replies for messages that have them
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
      source: m.source,
      analysisStatus: m.analysis_status,
      createdAt: m.created_at,
      replyCount: m.reply_count,
      replies: replies.map((r) => ({
        ts: r.ts,
        userId: r.user_id,
        displayName: r.display_name ?? r.real_name ?? r.user_id,
        text: r.text,
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const threads = await db.getActiveThreads(workspaceId, channelId, 24);

  // Get root message for each thread
  const enrichedThreads = await Promise.all(
    threads.map(async (thread) => {
      const rootMessages = await db.getMessagesEnriched(workspaceId, channelId, {
        limit: 1,
        threadTs: thread.thread_ts,
      });
      const root = rootMessages[0] ?? null;

      return {
        threadTs: thread.thread_ts,
        replyCount: thread.reply_count,
        lastActivity: thread.last_activity,
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

  res.status(200).json({
    channelId,
    total: threads.length,
    returned: enrichedThreads.length,
    threads: enrichedThreads,
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const rows = await db.getMessageAnalytics(workspaceId, channelId, {
    limit: query.data.limit,
    threadTs: query.data.threadTs ?? null,
    emotion: query.data.emotion ?? null,
    risk: query.data.risk ?? null,
  });

  const analytics = rows.map((r) => ({
    messageTs: r.message_ts,
    messageText: r.message_text,
    threadTs: r.thread_ts,
    user: {
      displayName: r.display_name ?? r.real_name ?? null,
    },
    dominantEmotion: r.dominant_emotion,
    confidence: r.confidence,
    escalationRisk: r.escalation_risk,
    sarcasmDetected: (r.raw_llm_response as Record<string, unknown>).sarcasm_detected ?? null,
    intendedEmotion: (r.raw_llm_response as Record<string, unknown>).intended_emotion ?? null,
    explanation: r.explanation,
    themes: r.themes,
    decisionSignal: r.decision_signal,
    llmProvider: r.llm_provider,
    llmModel: r.llm_model,
    tokenUsage: r.token_usage,
    analyzedAt: r.created_at,
  }));

  res.status(200).json({
    channelId,
    total: analytics.length,
    filters: {
      threadTs: query.data.threadTs ?? null,
      emotion: query.data.emotion ?? null,
      risk: query.data.risk ?? null,
    },
    analytics,
  });
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;
  const { reason } = body.data;

  await db.upsertChannel(workspaceId, channelId);
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;
  const { mode, threadTs } = body.data;

  if (mode === "thread" && !threadTs) {
    res.status(400).json({ error: "invalid_body", message: "threadTs is required when mode is 'thread'", requestId: req.id });
    return;
  }

  const channel = await db.getChannel(workspaceId, channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const jobId = await enqueueLLMAnalyze({
    workspaceId,
    channelId,
    triggerType: "manual",
    threadTs: threadTs ?? null,
  });

  log.info({ channelId, mode, threadTs, jobId }, "Manual LLM analysis queued");
  res.status(202).json({ status: "queued", channelId, mode, jobId });
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
  const workspaceId = query.data.workspace_id ?? DEFAULT_WORKSPACE;

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
