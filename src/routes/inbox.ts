import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import { listAttentionItems } from "../services/attentionItems.js";
import type { ConversationType } from "../types/database.js";

export const inboxRouter = Router();

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

const inboxQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(80),
  channel_id: z.string().min(1).max(100).optional(),
  kind: z
    .enum([
      "reply_needed",
      "follow_up_due",
      "leadership_instruction",
      "sentiment_risk",
      "thread_escalation",
      "all",
    ])
    .optional()
    .default("all"),
  group: z
    .enum([
      "needs_reply",
      "acknowledged",
      "escalated",
      "sentiment_risk",
      "resolved_recently",
      "all",
    ])
    .optional()
    .default("all"),
  severity: z.enum(["low", "medium", "high", "all"]).optional().default("all"),
  assignee_user_id: z.string().min(1).max(100).optional(),
  workflow_state: z
    .enum([
      "pending_reply_window",
      "awaiting_primary",
      "acknowledged_waiting",
      "escalated",
      "resolved",
      "dismissed",
      "expired",
      "all",
    ])
    .optional()
    .default("all"),
  resolution_state: z
    .enum(["open", "acknowledged", "escalated", "resolved", "all"])
    .optional()
    .default("all"),
  ownership_phase: z.enum(["primary", "escalation", "all"]).optional().default("all"),
  include_history: z.coerce.boolean().optional().default(false),
  conversation_type: z
    .enum(["public_channel", "private_channel", "dm", "group_dm", "all"])
    .optional()
    .default("all"),
});

inboxRouter.get("/", async (req, res) => {
  const query = inboxQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const items = await listAttentionItems(workspaceId, {
    limit: query.data.limit,
    channelId: query.data.channel_id ?? null,
    kind: query.data.kind,
    group: query.data.group,
    severity: query.data.severity,
    assigneeUserId: query.data.assignee_user_id ?? null,
    workflowState: query.data.workflow_state as
      | "pending_reply_window"
      | "awaiting_primary"
      | "acknowledged_waiting"
      | "escalated"
      | "resolved"
      | "dismissed"
      | "expired"
      | "all",
    resolutionState: query.data.resolution_state,
    ownershipPhase: query.data.ownership_phase,
    includeHistory: query.data.include_history,
    conversationType: query.data.conversation_type as ConversationType | "all",
  });

  res.status(200).json({
    total: items.length,
    items,
  });
});
