import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import * as db from "../db/queries.js";
import { reconcileMissingFollowUps } from "../services/followUpReconcile.js";
import { buildRoleDirectory, reviewRoleAssignment } from "../services/roleInference.js";

export const rolesRouter = Router();

function resolveWorkspaceId(
  req: { workspaceId?: string },
  requestedWorkspaceId?: string,
): string {
  return req.workspaceId ?? requestedWorkspaceId ?? DEFAULT_WORKSPACE;
}

const workspaceQuery = z.object({
  workspace_id: z.string().min(1).max(100).optional(),
});

const roleParams = z.object({
  userId: z.string().min(1).max(100),
});

const channelParams = z.object({
  channelId: z.string().min(1).max(100),
});

const reviewBody = z.object({
  role: z.enum(["client", "worker", "senior", "observer"]).optional(),
  action: z.enum(["confirm", "reject", "clear"]),
  displayLabel: z.string().max(50).optional(),
});

rolesRouter.get("/", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const roles = await buildRoleDirectory(workspaceId);

  res.status(200).json({
    total: roles.length,
    roles,
  });
});

rolesRouter.put("/:userId", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const params = roleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }

  const body = reviewBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_body", details: body.error.issues, requestId: req.id });
    return;
  }

  if (body.data.action !== "clear" && !body.data.role) {
    res.status(400).json({ error: "role_required", requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  await reviewRoleAssignment({
    workspaceId,
    userId: params.data.userId,
    role: body.data.role ?? "observer",
    action: body.data.action,
    displayLabel: body.data.displayLabel,
  });
  const reconciledCandidates =
    body.data.action === "clear"
      ? 0
      : await reconcileMissingFollowUps({
          workspaceId,
          requesterUserId: params.data.userId,
          limit: 250,
        });

  const roles = await buildRoleDirectory(workspaceId);
  const updated = roles.find((entry) => entry.userId === params.data.userId) ?? null;

  res.status(200).json({
    userId: params.data.userId,
    updated,
    reconciledCandidates,
  });
});

rolesRouter.get("/channel/:channelId", async (req, res) => {
  const query = workspaceQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const params = channelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "invalid_params", details: params.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = resolveWorkspaceId(req, query.data.workspace_id);
  const { channelId } = params.data;

  const [membersWithProfiles, policy] = await Promise.all([
    db.getChannelMembersWithProfiles(workspaceId, channelId),
    db.getFollowUpRule(workspaceId, channelId),
  ]);

  const userIds = membersWithProfiles.map((m) => m.user_id);
  const roleAssignments = await db.getRoleAssignmentsForUsers(workspaceId, userIds);
  const roleMap = new Map(roleAssignments.map((r) => [r.user_id, r]));

  const ownerSet = new Set(policy?.owner_user_ids ?? []);
  const clientSet = new Set(policy?.client_user_ids ?? []);
  const seniorSet = new Set(policy?.senior_user_ids ?? []);

  const members = membersWithProfiles.map((m) => {
    const roleAssignment = roleMap.get(m.user_id);
    return {
      userId: m.user_id,
      displayName: m.display_name ?? m.real_name ?? m.user_id,
      profileImage: m.profile_image ?? null,
      email: m.email ?? null,
      isBot: m.is_bot,
      role: roleAssignment?.role ?? null,
      displayLabel: roleAssignment?.display_label ?? null,
      policyFlags: {
        isOwner: ownerSet.has(m.user_id),
        isClient: clientSet.has(m.user_id),
        isSenior: seniorSet.has(m.user_id),
      },
    };
  });

  res.status(200).json({
    channelId,
    total: members.length,
    members,
  });
});
