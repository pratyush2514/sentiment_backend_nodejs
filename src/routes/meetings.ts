import { Router } from "express";
import * as db from "../db/queries.js";
import { generatePrepBrief } from "../services/meetingPrepBrief.js";
import { logger } from "../utils/logger.js";
import type {
  MeetingObligationStatus,
  MeetingProcessingStatus,
  MeetingRow,
} from "../types/database.js";
import type { Request, Response } from "express";

const log = logger.child({ service: "meetings-routes" });

export const meetingsRouter = Router();

function serializeMeeting(meeting: MeetingRow) {
  const { meeting_source, ...rest } = meeting;
  return {
    ...rest,
    source: meeting_source,
    confidence: meeting_source === "shared_link" ? "medium" : "high",
  };
}

function readRequestedWorkspaceId(req: Request): string | null {
  const queryWorkspaceId = req.query.workspace_id;
  if (typeof queryWorkspaceId === "string" && queryWorkspaceId.length > 0) {
    return queryWorkspaceId;
  }

  if (req.body && typeof req.body === "object") {
    if (
      "workspace_id" in req.body &&
      typeof req.body.workspace_id === "string" &&
      req.body.workspace_id.length > 0
    ) {
      return req.body.workspace_id;
    }
    if (
      "workspaceId" in req.body &&
      typeof req.body.workspaceId === "string" &&
      req.body.workspaceId.length > 0
    ) {
      return req.body.workspaceId;
    }
  }

  return null;
}

function resolveWorkspaceId(req: Request, res: Response): string | null {
  const requestedWorkspaceId = readRequestedWorkspaceId(req);
  const authenticatedWorkspaceId = req.workspaceId ?? null;

  if (
    authenticatedWorkspaceId &&
    requestedWorkspaceId &&
    requestedWorkspaceId !== authenticatedWorkspaceId
  ) {
    res.status(403).json({ error: "workspace_mismatch" });
    return null;
  }

  const workspaceId = authenticatedWorkspaceId ?? requestedWorkspaceId;
  if (!workspaceId) {
    res.status(400).json({ error: "workspace_id required" });
    return null;
  }

  return workspaceId;
}

// ─── Meetings ────────────────────────────────────────────────────────────────

meetingsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const result = await db.listMeetings(workspaceId, {
      channelId: req.query.channel_id as string | undefined,
      processingStatus: (req.query.status as MeetingProcessingStatus) || undefined,
      limit: parseInt(req.query.limit as string, 10) || 20,
      offset: parseInt(req.query.offset as string, 10) || 0,
    });

    res.json({
      meetings: result.meetings.map(serializeMeeting),
      total: result.total,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to list meetings");
    res.status(500).json({ error: "internal_error" });
  }
});

meetingsRouter.get("/:meetingId", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const meeting = await db.getMeeting(workspaceId, String(req.params.meetingId));
    if (!meeting) {
      res.status(404).json({ error: "meeting_not_found" });
      return;
    }

    const obligations = await db.getMeetingObligations(workspaceId, String(req.params.meetingId));
    res.json({ meeting: serializeMeeting(meeting), obligations });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to get meeting");
    res.status(500).json({ error: "internal_error" });
  }
});

meetingsRouter.get("/:meetingId/obligations", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const obligations = await db.getMeetingObligations(workspaceId, String(req.params.meetingId));
    res.json({ obligations });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to get meeting obligations");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── Meeting Obligations (cross-meeting) ─────────────────────────────────────

meetingsRouter.get("/obligations/list", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const result = await db.listMeetingObligations(workspaceId, {
      channelId: req.query.channel_id as string | undefined,
      status: req.query.status as MeetingObligationStatus | undefined,
      ownerUserId: req.query.owner_user_id as string | undefined,
      limit: parseInt(req.query.limit as string, 10) || 50,
      offset: parseInt(req.query.offset as string, 10) || 0,
    });

    res.json(result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to list meeting obligations");
    res.status(500).json({ error: "internal_error" });
  }
});

meetingsRouter.patch("/obligations/:obligationId", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const { status, resolution_evidence } = req.body ?? {};
    if (!status || !["open", "in_progress", "completed", "dismissed", "expired"].includes(status)) {
      res.status(400).json({ error: "status must be one of: open, in_progress, completed, dismissed, expired" });
      return;
    }

    await db.updateMeetingObligationStatus(
      workspaceId,
      String(req.params.obligationId),
      status,
      resolution_evidence ?? null,
    );

    res.json({ status: "updated" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to update meeting obligation");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── Meeting Channel Links ───────────────────────────────────────────────────

meetingsRouter.get("/channel-links/list", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const links = await db.listMeetingChannelLinks(workspaceId);
    res.json({ links });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to list meeting channel links");
    res.status(500).json({ error: "internal_error" });
  }
});

meetingsRouter.post("/channel-links", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    const { channel_id, link_type, domain_pattern, title_pattern, recorder_email_pattern, priority, digest_enabled, tracking_enabled } = req.body ?? {};
    if (!channel_id) {
      res.status(400).json({ error: "channel_id required" });
      return;
    }

    const link = await db.upsertMeetingChannelLink({
      workspaceId,
      channelId: channel_id,
      linkType: link_type ?? "manual",
      domainPattern: domain_pattern ?? null,
      titlePattern: title_pattern ?? null,
      recorderEmailPattern: recorder_email_pattern ?? null,
      priority: priority ?? 0,
      digestEnabled: digest_enabled ?? true,
      trackingEnabled: tracking_enabled ?? true,
    });

    res.json({ link });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to create meeting channel link");
    res.status(500).json({ error: "internal_error" });
  }
});

meetingsRouter.delete("/channel-links/:linkId", async (req: Request, res: Response) => {
  try {
    const workspaceId = resolveWorkspaceId(req, res);
    if (!workspaceId) {
      return;
    }

    await db.deleteMeetingChannelLink(workspaceId, String(req.params.linkId));
    res.json({ status: "deleted" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg }, "Failed to delete meeting channel link");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── Pre-meeting prep brief ─────────────────────────────────────────────────

meetingsRouter.get("/prep-brief", async (req: Request, res: Response) => {
  const workspaceId = resolveWorkspaceId(req, res);
  const channelId = String(req.query.channel_id ?? "");
  const meetingTitle = req.query.meeting_title ? String(req.query.meeting_title) : null;

  if (!workspaceId || !channelId) {
    res.status(400).json({ error: "workspace_id and channel_id required" });
    return;
  }

  try {
    const brief = await generatePrepBrief(workspaceId, channelId, meetingTitle);
    res.json(brief);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ err: errMsg, channelId }, "Failed to generate prep brief");
    res.status(500).json({ error: "internal_error" });
  }
});
