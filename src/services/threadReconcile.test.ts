import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries.js", () => ({
  getReadyChannels: vi.fn(),
  getChannel: vi.fn(),
  getActiveThreads: vi.fn(),
  getMessagesByTs: vi.fn(),
  updateLastReconcileAt: vi.fn(),
  upsertThreadEdge: vi.fn(),
  upsertMessage: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueThreadReconcile: vi.fn(),
  enqueueMessageIngest: vi.fn().mockResolvedValue("job-message-ingest-1"),
}));

vi.mock("./slackClientFactory.js", () => ({
  getSlackClient: vi.fn(),
}));

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const slackClientFactory = await import("./slackClientFactory.js");
const { reconcileChannelThreads } = await import("./threadReconcile.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannel).mockResolvedValue({
    id: "channel-row-1",
    workspace_id: "default",
    channel_id: "C123",
    name: "sage_team",
    conversation_type: "public_channel",
    status: "ready",
    initialized_at: new Date("2026-03-19T04:00:00.000Z"),
    last_event_at: new Date("2026-03-19T05:00:00.000Z"),
    created_at: new Date("2026-03-19T04:00:00.000Z"),
    updated_at: new Date("2026-03-19T05:00:00.000Z"),
  });
  vi.mocked(db.getActiveThreads).mockResolvedValue([]);
  vi.mocked(db.getMessagesByTs).mockResolvedValue([]);
  vi.mocked(db.updateLastReconcileAt).mockResolvedValue();
  vi.mocked(slackClientFactory.getSlackClient).mockResolvedValue({
    fetchChannelHistory: vi.fn().mockResolvedValue({
      ok: true,
      messages: [],
      response_metadata: {},
    }),
    fetchThreadReplies: vi.fn(),
  } as never);
});

describe("reconcileChannelThreads", () => {
  it("enqueues missing recent top-level messages through the realtime ingest pipeline", async () => {
    const fetchChannelHistory = vi.fn().mockResolvedValue({
      ok: true,
      messages: [
        {
          type: "message",
          ts: "1773891360.000100",
          user: "U123",
          text: "Today update from sage_team",
        },
      ],
      response_metadata: {},
    });
    vi.mocked(slackClientFactory.getSlackClient).mockResolvedValue({
      fetchChannelHistory,
      fetchThreadReplies: vi.fn(),
    } as never);

    await reconcileChannelThreads("default", "C123");

    expect(boss.enqueueMessageIngest).toHaveBeenCalledWith({
      workspaceId: "default",
      channelId: "C123",
      ts: "1773891360.000100",
      userId: "U123",
      text: "Today update from sage_team",
      threadTs: null,
      eventId: "reconcile:C123:1773891360.000100",
      files: undefined,
    });
    expect(db.updateLastReconcileAt).toHaveBeenCalledWith("default", "C123");
  });

  it("does not re-enqueue messages that are already stored", async () => {
    const fetchChannelHistory = vi.fn().mockResolvedValue({
      ok: true,
      messages: [
        {
          type: "message",
          ts: "1773891360.000100",
          user: "U123",
          text: "Already stored update",
        },
      ],
      response_metadata: {},
    });
    vi.mocked(slackClientFactory.getSlackClient).mockResolvedValue({
      fetchChannelHistory,
      fetchThreadReplies: vi.fn(),
    } as never);
    vi.mocked(db.getMessagesByTs).mockResolvedValue([
      {
        id: "message-row-1",
        workspace_id: "default",
        channel_id: "C123",
        ts: "1773891360.000100",
        thread_ts: null,
        user_id: "U123",
        text: "Already stored update",
        normalized_text: null,
        subtype: null,
        bot_id: null,
        source: "realtime",
        analysis_status: "completed",
        files_json: null,
        links_json: null,
        created_at: new Date("2026-03-19T05:10:00.000Z"),
        updated_at: new Date("2026-03-19T05:10:00.000Z"),
      },
    ]);

    await reconcileChannelThreads("default", "C123");

    expect(boss.enqueueMessageIngest).not.toHaveBeenCalled();
  });
});
