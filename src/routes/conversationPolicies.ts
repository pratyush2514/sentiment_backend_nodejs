import { Router } from "express";
import { z } from "zod/v4";
import { config } from "../config.js";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import {
  deriveRecommendedChannelMode,
  normalizeChannelModeOverride,
  resolveEffectiveChannelMode,
} from "../services/channelMode.js";
import {
  deriveRecommendedImportanceTier,
  normalizeImportanceTierOverride,
  resolveEffectiveImportanceTier,
} from "../services/conversationImportance.js";
import { reconcileMissingFollowUps } from "../services/followUpReconcile.js";

export const conversationPoliciesRouter = Router();

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
  channelId: z.string().min(1).max(100),
});

const policyBody = z.object({
  enabled: z.boolean(),
  slaHours: z.coerce.number().min(0.01).max(24 * 30),
  analysisWindowDays: z.coerce.number().int().min(1).max(30).default(7),
  ownerUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  clientUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  seniorUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  importanceTierOverride: z.enum(["auto", "high_value", "standard", "low_value"]).default("auto"),
  channelModeOverride: z.enum(["auto", "collaboration", "automation", "mixed"]).default("auto"),
  slackNotificationsEnabled: z.boolean().default(true),
  muted: z.boolean().default(false),
  privacyOptIn: z.boolean().default(false),
  conversationType: z.enum(["public_channel", "private_channel", "dm", "group_dm"]).default("public_channel"),
});

conversationPoliciesRouter.get("/", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const policies = await db.listConversationPolicies(workspaceId);

  res.status(200).json({
    total: policies.length,
    policies: policies.map((policy) => ({
      channelId: policy.channel_id,
      channelName: policy.channel_name ?? policy.channel_id,
      conversationType: policy.conversation_type,
      enabled: policy.enabled,
      slaHours: policy.sla_hours ?? config.FOLLOW_UP_DEFAULT_SLA_HOURS,
      analysisWindowDays: policy.analysis_window_days ?? config.SUMMARY_WINDOW_DAYS,
      ownerUserIds: policy.owner_user_ids ?? [],
      clientUserIds: policy.client_user_ids ?? [],
      seniorUserIds: policy.senior_user_ids ?? [],
      importanceTierOverride: normalizeImportanceTierOverride(policy.importance_tier_override),
      recommendedImportanceTier: deriveRecommendedImportanceTier({
        channelName: policy.channel_name,
        conversationType: policy.conversation_type,
        clientUserIds: policy.client_user_ids,
      }),
      effectiveImportanceTier: resolveEffectiveImportanceTier({
        channelName: policy.channel_name,
        conversationType: policy.conversation_type,
        clientUserIds: policy.client_user_ids,
        importanceTierOverride: policy.importance_tier_override,
      }),
      channelModeOverride: normalizeChannelModeOverride(policy.channel_mode_override),
      recommendedChannelMode: deriveRecommendedChannelMode({
        channelName: policy.channel_name,
        conversationType: policy.conversation_type,
      }),
      effectiveChannelMode: resolveEffectiveChannelMode({
        channelName: policy.channel_name,
        conversationType: policy.conversation_type,
        channelModeOverride: policy.channel_mode_override,
      }),
      slackNotificationsEnabled: policy.slack_notifications_enabled ?? true,
      muted: policy.muted ?? false,
      privacyOptIn: policy.privacy_opt_in ?? false,
    })),
  });
});

conversationPoliciesRouter.put("/:channelId", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const params = channelIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }

  const body = policyBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const channel = await db.getChannel(workspaceId, params.data.channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found", requestId: req.id });
    return;
  }

  const updated = await db.upsertFollowUpRule({
    workspaceId,
    channelId: params.data.channelId,
    enabled: body.data.enabled,
    slaHours: body.data.slaHours,
    analysisWindowDays: body.data.analysisWindowDays,
    ownerUserIds: body.data.ownerUserIds,
    clientUserIds: body.data.clientUserIds,
    seniorUserIds: body.data.seniorUserIds,
    importanceTierOverride: body.data.importanceTierOverride,
    channelModeOverride: body.data.channelModeOverride,
    slackNotificationsEnabled: body.data.slackNotificationsEnabled,
    muted: body.data.muted,
    privacyOptIn: body.data.privacyOptIn,
    conversationType: body.data.conversationType,
  });
  const reconciledCandidates = await reconcileMissingFollowUps({
    workspaceId,
    channelId: params.data.channelId,
    limit: 400,
    hoursBack: updated.analysis_window_days * 24,
  });

  res.status(200).json({
    channelId: updated.channel_id,
    channelName: channel.name ?? channel.channel_id,
    conversationType: updated.conversation_type,
    enabled: updated.enabled,
    slaHours: updated.sla_hours,
    analysisWindowDays: updated.analysis_window_days,
    ownerUserIds: updated.owner_user_ids,
    clientUserIds: updated.client_user_ids,
    seniorUserIds: updated.senior_user_ids,
    importanceTierOverride: normalizeImportanceTierOverride(updated.importance_tier_override),
    recommendedImportanceTier: deriveRecommendedImportanceTier({
      channelName: channel.name ?? channel.channel_id,
      conversationType: updated.conversation_type,
      clientUserIds: updated.client_user_ids,
    }),
    effectiveImportanceTier: resolveEffectiveImportanceTier({
      channelName: channel.name ?? channel.channel_id,
      conversationType: updated.conversation_type,
      clientUserIds: updated.client_user_ids,
      importanceTierOverride: updated.importance_tier_override,
    }),
    channelModeOverride: normalizeChannelModeOverride(updated.channel_mode_override),
    recommendedChannelMode: deriveRecommendedChannelMode({
      channelName: channel.name ?? channel.channel_id,
      conversationType: updated.conversation_type,
    }),
    effectiveChannelMode: resolveEffectiveChannelMode({
      channelName: channel.name ?? channel.channel_id,
      conversationType: updated.conversation_type,
      channelModeOverride: updated.channel_mode_override,
    }),
    slackNotificationsEnabled: updated.slack_notifications_enabled,
    muted: updated.muted,
    privacyOptIn: updated.privacy_opt_in,
    reconciledCandidates,
  });
});
