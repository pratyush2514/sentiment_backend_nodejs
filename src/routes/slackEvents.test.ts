import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { NODE_ENV: "test", SLACK_SIGNING_SECRET: "test-secret" },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../middleware/slackSignature.js", () => ({
  getRawBody: vi.fn((req) => {
    // Return the buffered body as string
    if (req._rawBody) return req._rawBody;
    return "{}";
  }),
  verifySlackSignature: vi.fn((_req, _res, next) => next()),
}));

vi.mock("../db/queries.js", () => ({
  markEventSeen: vi.fn().mockResolvedValue(true),
  upsertChannel: vi.fn().mockResolvedValue({ channel_id: "C123" }),
  getChannel: vi.fn(),
  upsertMessage: vi.fn(),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueBackfill: vi.fn().mockResolvedValue("job-bf-1"),
  enqueueMessageIngest: vi.fn().mockResolvedValue("job-mi-1"),
}));

vi.mock("../services/slackClient.js", () => ({
  getBotUserId: vi.fn().mockReturnValue("UBOT123"),
}));

vi.mock("../types/slack.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../types/slack.js")>();
  return {
    ...actual,
    isProcessableHumanMessageEvent: vi.fn(),
    isBotJoinEvent: vi.fn(),
  };
});

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const slackTypes = await import("../types/slack.js");
const { getRawBody } = await import("../middleware/slackSignature.js");
const { slackEventsRouter } = await import("./slackEvents.js");

function createApp() {
  const app = express();
  app.use("/slack/events", slackEventsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply defaults after clearAllMocks
  vi.mocked(db.markEventSeen).mockResolvedValue(true);
  vi.mocked(db.upsertChannel).mockResolvedValue({ channel_id: "C123" } as never);
  vi.mocked(slackTypes.isBotJoinEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isProcessableHumanMessageEvent).mockReturnValue(false);
});

describe("Slack Events Route", () => {
  it("responds to url_verification with challenge", async () => {
    vi.mocked(getRawBody).mockReturnValue(
      JSON.stringify({ type: "url_verification", challenge: "test-challenge-123" }),
    );

    const res = await request(createApp())
      .post("/slack/events")
      .send({ type: "url_verification", challenge: "test-challenge-123" });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe("test-challenge-123");
  });

  it("skips duplicate events", async () => {
    vi.mocked(db.markEventSeen).mockResolvedValue(false);
    vi.mocked(getRawBody).mockReturnValue(
      JSON.stringify({
        type: "event_callback",
        event_id: "ev-dup",
        event: { type: "message", channel: "C123", user: "U1", text: "hello", ts: "1.1" },
      }),
    );

    const res = await request(createApp())
      .post("/slack/events")
      .send({
        type: "event_callback",
        event_id: "ev-dup",
        event: { type: "message", channel: "C123", user: "U1", text: "hello", ts: "1.1" },
      });

    expect(res.status).toBe(200);
    expect(boss.enqueueMessageIngest).not.toHaveBeenCalled();
  });

  it("triggers backfill on bot join", async () => {
    vi.mocked(slackTypes.isBotJoinEvent).mockReturnValue(true);
    vi.mocked(getRawBody).mockReturnValue(
      JSON.stringify({
        type: "event_callback",
        event_id: "ev-join",
        event: { type: "member_joined_channel", channel: "C456", user: "UBOT123", ts: "1.2" },
      }),
    );

    const res = await request(createApp())
      .post("/slack/events")
      .send({
        type: "event_callback",
        event_id: "ev-join",
        event: { type: "member_joined_channel", channel: "C456", user: "UBOT123", ts: "1.2" },
      });

    expect(res.status).toBe(200);
    expect(db.upsertChannel).toHaveBeenCalledWith(expect.any(String), "C456");
    expect(boss.enqueueBackfill).toHaveBeenCalled();
  });

  it("enqueues message ingest for human message in ready channel", async () => {
    vi.mocked(slackTypes.isProcessableHumanMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: null, status: "ready", initialized_at: new Date(),
      last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
    });
    vi.mocked(getRawBody).mockReturnValue(
      JSON.stringify({
        type: "event_callback",
        event_id: "ev-msg",
        event: { type: "message", channel: "C789", user: "U2", text: "test message", ts: "1.3" },
      }),
    );

    const res = await request(createApp())
      .post("/slack/events")
      .send({
        type: "event_callback",
        event_id: "ev-msg",
        event: { type: "message", channel: "C789", user: "U2", text: "test message", ts: "1.3" },
      });

    expect(res.status).toBe(200);
    expect(boss.enqueueMessageIngest).toHaveBeenCalled();
  });

  it("stores message directly when channel is initializing", async () => {
    vi.mocked(slackTypes.isProcessableHumanMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: null, status: "initializing", initialized_at: null,
      last_event_at: null, created_at: new Date(), updated_at: new Date(),
    });
    vi.mocked(getRawBody).mockReturnValue(
      JSON.stringify({
        type: "event_callback",
        event_id: "ev-init",
        event: { type: "message", channel: "C789", user: "U3", text: "during init", ts: "1.4" },
      }),
    );

    const res = await request(createApp())
      .post("/slack/events")
      .send({
        type: "event_callback",
        event_id: "ev-init",
        event: { type: "message", channel: "C789", user: "U3", text: "during init", ts: "1.4" },
      });

    expect(res.status).toBe(200);
    expect(db.upsertMessage).toHaveBeenCalled();
    expect(boss.enqueueMessageIngest).not.toHaveBeenCalled();
  });
});
