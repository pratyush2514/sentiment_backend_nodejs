import { Router } from "express";
import { z } from "zod/v4";
import { config } from "../config.js";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";

export const followUpRulesRouter = Router();

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

const workspaceQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
});

const channelIdParam = z.object({
  channelId: z.string().regex(/^[A-Z0-9]{1,20}$/i, "Invalid channel ID format"),
});

const ruleBody = z.object({
  enabled: z.boolean(),
  slaHours: z.coerce.number().min(0.01).max(24 * 30),
  analysisWindowDays: z.coerce.number().int().min(1).max(30).default(7),
  ownerUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  clientUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
});

followUpRulesRouter.get("/", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const [channels, rules] = await Promise.all([
    db.getAllChannelsWithState(workspaceId),
    db.listFollowUpRules(workspaceId),
  ]);

  const ruleMap = new Map(rules.map((rule) => [rule.channel_id, rule]));

  res.status(200).json({
    total: channels.length,
    rules: channels.map((channel) => {
      const rule = ruleMap.get(channel.channel_id);
      return {
        channelId: channel.channel_id,
        channelName: channel.name ?? channel.channel_id,
        enabled: rule?.enabled ?? false,
        slaHours: rule?.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
        analysisWindowDays: rule?.analysis_window_days ?? config.SUMMARY_WINDOW_DAYS,
        ownerUserIds: rule?.owner_user_ids ?? [],
        clientUserIds: rule?.client_user_ids ?? [],
      };
    }),
  });
});

followUpRulesRouter.put("/:channelId", async (req, res) => {
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

  const body = ruleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const channelId = params.data.channelId;
  const channel = await db.getChannel(workspaceId, channelId);
  const existingRule = await db.getFollowUpRule(workspaceId, channelId);

  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const updated = await db.upsertFollowUpRule({
    workspaceId,
    channelId,
    enabled: body.data.enabled,
    slaHours: body.data.slaHours,
    analysisWindowDays: body.data.analysisWindowDays,
    ownerUserIds: body.data.ownerUserIds,
    clientUserIds: body.data.clientUserIds,
    seniorUserIds: existingRule?.senior_user_ids ?? [],
    importanceTierOverride: existingRule?.importance_tier_override ?? "auto",
    channelModeOverride: existingRule?.channel_mode_override ?? "auto",
    slackNotificationsEnabled: existingRule?.slack_notifications_enabled ?? true,
    muted: existingRule?.muted ?? false,
    privacyOptIn: existingRule?.privacy_opt_in ?? false,
    conversationType: existingRule?.conversation_type ?? channel.conversation_type,
  });

  res.status(200).json({
    channelId: updated.channel_id,
    enabled: updated.enabled,
    slaHours: updated.sla_hours,
    analysisWindowDays: updated.analysis_window_days,
    ownerUserIds: updated.owner_user_ids,
    clientUserIds: updated.client_user_ids,
  });
});
