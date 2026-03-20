import { Router } from "express";
import { z } from "zod/v4";
import { DEFAULT_WORKSPACE } from "../constants.js";
import { getSlackClient } from "../services/slackClientFactory.js";

export const slackRouter = Router();

const permalinkQuery = z.object({
  channel_id: z.string().min(1).max(100),
  message_ts: z.string().regex(/^\d+\.\d+$/, "Invalid Slack timestamp format"),
});

slackRouter.get("/permalink", async (req, res) => {
  const query = permalinkQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "invalid_query", details: query.error.issues, requestId: req.id });
    return;
  }

  const workspaceId = req.workspaceId ?? DEFAULT_WORKSPACE;
  const slack = await getSlackClient(workspaceId);
  const permalink = await slack.fetchMessagePermalink(
    query.data.channel_id,
    query.data.message_ts,
  );

  if (!permalink) {
    res.status(404).json({ error: "permalink_not_found", requestId: req.id });
    return;
  }

  res.status(200).json({
    channelId: query.data.channel_id,
    messageTs: query.data.message_ts,
    permalink,
  });
});
