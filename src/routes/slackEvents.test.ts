import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "test",
    SLACK_SIGNING_SECRET: "test-secret",
    FOLLOW_UP_ACK_REACTIONS: "+1,white_check_mark,eyes,heavy_check_mark,thumbsup,pray",
    FOLLOW_UP_ACK_EXTENSION_HOURS: 12,
    FOLLOW_UP_DEFAULT_SLA_HOURS: 48,
  },
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
  reserveSlackEvent: vi.fn().mockResolvedValue("reserved"),
  completeSlackEvent: vi.fn().mockResolvedValue(undefined),
  failSlackEvent: vi.fn().mockResolvedValue(undefined),
  hasSeenEvent: vi.fn().mockResolvedValue(false),
  markEventSeen: vi.fn().mockResolvedValue(true),
  upsertChannel: vi.fn().mockResolvedValue({ channel_id: "C123" }),
  getChannel: vi.fn(),
  updateChannelStatus: vi.fn().mockResolvedValue(undefined),
  upsertMessage: vi.fn(),
  replaceMessageContent: vi.fn(),
  markMessageDeleted: vi.fn().mockResolvedValue(undefined),
  deleteMessageAnalytics: vi.fn().mockResolvedValue(undefined),
  listOpenFollowUpsBySourceMessage: vi.fn().mockResolvedValue([]),
  listOpenFollowUpsByResponderMessage: vi.fn().mockResolvedValue([]),
  listResolvedFollowUpsByResolvedMessage: vi.fn().mockResolvedValue([]),
  getOpenFollowUpBySourceMessage: vi.fn().mockResolvedValue(null),
  acknowledgeFollowUpItem: vi.fn().mockResolvedValue(undefined),
  reopenFollowUpItem: vi.fn().mockResolvedValue(undefined),
  dismissFollowUpItem: vi.fn().mockResolvedValue(undefined),
  recordFollowUpEvent: vi.fn().mockResolvedValue(undefined),
  updateNormalizedText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queue/boss.js", () => ({
  enqueueBackfill: vi.fn().mockResolvedValue("job-bf-1"),
  enqueueMessageIngest: vi.fn().mockResolvedValue("job-mi-1"),
  enqueueLLMAnalyze: vi.fn().mockResolvedValue("job-llm-edit-1"),
}));

vi.mock("../services/eventBus.js", () => ({
  eventBus: {
    createAndPublish: vi.fn(),
  },
}));

vi.mock("../services/followUpReminderDms.js", () => ({
  clearFollowUpReminderDms: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/followUpEvents.js", () => ({
  emitFollowUpAlert: vi.fn(),
}));

vi.mock("../services/followUpMonitor.js", () => ({
  reconcileFollowUpSourceEdit: vi.fn().mockResolvedValue(undefined),
}));

const mockSlackClient = {
  fetchChannelInfo: vi.fn().mockResolvedValue({
    ok: true,
    channel: { id: "C123", name: "general", is_private: false },
  }),
  getBotUserId: vi.fn().mockReturnValue("UBOT123"),
  resolveBotUserId: vi.fn().mockResolvedValue("UBOT123"),
};

vi.mock("../services/slackClientFactory.js", () => ({
  getSlackClient: vi.fn().mockResolvedValue(mockSlackClient),
  invalidateWorkspaceCache: vi.fn(),
}));

vi.mock("../services/channelMetadata.js", () => ({
  resolveChannelMetadata: vi.fn(),
}));

vi.mock("../types/slack.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../types/slack.js")>();
  return {
    ...actual,
    isProcessableMessageEvent: vi.fn(),
    isBotJoinEvent: vi.fn(),
    isMessageChangedEvent: vi.fn(),
    isMessageDeletedEvent: vi.fn(),
    isReactionAddedEvent: vi.fn(),
    isReactionRemovedEvent: vi.fn(),
  };
});

const db = await import("../db/queries.js");
const boss = await import("../queue/boss.js");
const _slackClientFactory = await import("../services/slackClientFactory.js");
const channelMetadata = await import("../services/channelMetadata.js");
const eventBus = await import("../services/eventBus.js");
const followUpReminderDms = await import("../services/followUpReminderDms.js");
const followUpEvents = await import("../services/followUpEvents.js");
const followUpMonitor = await import("../services/followUpMonitor.js");
const slackTypes = await import("../types/slack.js");
const { getRawBody } = await import("../middleware/slackSignature.js");
const { slackEventsRouter } = await import("./slackEvents.js");

const slackEventsPostHandler = slackEventsRouter.stack.find((layer) => {
  const route = layer.route as
    | { path?: string; methods?: Record<string, boolean> }
    | undefined;
  return route?.path === "/" && route.methods?.post;
})?.route?.stack.at(-1)?.handle;

if (!slackEventsPostHandler) {
  throw new Error("Unable to locate the slack events route handler in tests");
}

type SlackTestResponse = {
  statusCode: number;
  body: unknown;
  status(code: number): SlackTestResponse;
  json(payload: unknown): SlackTestResponse;
  send(payload: unknown): SlackTestResponse;
  sendStatus(code: number): SlackTestResponse;
};

function createMockResponse(): SlackTestResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

function buildFollowUpItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "fu-1",
    workspace_id: "default",
    channel_id: "C789",
    source_message_ts: "1710000000.000100",
    source_thread_ts: null,
    requester_user_id: "U-requester",
    status: "open",
    workflow_state: "awaiting_primary",
    seriousness: "medium",
    seriousness_score: 4,
    detection_mode: "heuristic",
    reason_codes: ["request_language"],
    summary: "Needs a reply.",
    due_at: new Date("2026-03-18T00:00:00.000Z"),
    primary_responder_ids: ["U-helper"],
    escalation_responder_ids: ["U-senior"],
    last_alerted_at: null,
    alert_count: 1,
    last_request_ts: "1710000000.000100",
    repeated_ask_count: 1,
    acknowledged_at: null,
    acknowledged_by_user_id: null,
    acknowledgment_source: null,
    engaged_at: null,
    escalated_at: null,
    ignored_score: 0,
    resolved_via_escalation: false,
    primary_missed_sla: false,
    visibility_after: new Date("2026-03-18T00:00:00.000Z"),
    last_responder_user_id: null,
    last_responder_message_ts: null,
    next_expected_response_at: new Date("2026-03-18T06:00:00.000Z"),
    resolved_at: null,
    resolved_message_ts: null,
    resolution_reason: null,
    resolution_scope: null,
    resolved_by_user_id: null,
    last_engagement_at: null,
    dismissed_at: null,
    metadata_json: {},
    snoozed_until: null,
    last_dm_refs: [],
    created_at: new Date("2026-03-18T00:00:00.000Z"),
    updated_at: new Date("2026-03-18T00:00:00.000Z"),
    ...overrides,
  };
}

async function postSlackEvent(body: Record<string, unknown>): Promise<SlackTestResponse> {
  vi.mocked(getRawBody).mockReturnValue(JSON.stringify(body));
  const req = {
    method: "POST",
    url: "/slack/events",
    headers: {},
    body: Buffer.from(JSON.stringify(body)),
    _rawBody: JSON.stringify(body),
  } as never;
  const res = createMockResponse() as never;
  await slackEventsPostHandler!(req, res, vi.fn());
  return res as SlackTestResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply defaults after clearAllMocks
  vi.mocked(db.reserveSlackEvent).mockResolvedValue("reserved" as never);
  vi.mocked(db.completeSlackEvent).mockResolvedValue(undefined as never);
  vi.mocked(db.failSlackEvent).mockResolvedValue(undefined as never);
  vi.mocked(db.markEventSeen).mockResolvedValue(true as never);
  vi.mocked(db.hasSeenEvent).mockResolvedValue(false as never);
  vi.mocked(db.upsertChannel).mockResolvedValue({ channel_id: "C123" } as never);
  vi.mocked(db.replaceMessageContent).mockResolvedValue(null as never);
  vi.mocked(db.markMessageDeleted).mockResolvedValue(null as never);
  vi.mocked(db.deleteMessageAnalytics).mockResolvedValue(undefined as never);
  vi.mocked(db.listOpenFollowUpsBySourceMessage).mockResolvedValue([] as never);
  vi.mocked(db.listOpenFollowUpsByResponderMessage).mockResolvedValue([] as never);
  vi.mocked(db.listResolvedFollowUpsByResolvedMessage).mockResolvedValue([] as never);
  vi.mocked(db.getOpenFollowUpBySourceMessage).mockResolvedValue(null as never);
  vi.mocked(db.acknowledgeFollowUpItem).mockResolvedValue(undefined as never);
  vi.mocked(db.reopenFollowUpItem).mockResolvedValue(undefined as never);
  vi.mocked(db.dismissFollowUpItem).mockResolvedValue(undefined as never);
  vi.mocked(db.recordFollowUpEvent).mockResolvedValue(undefined as never);
  vi.mocked(db.updateNormalizedText).mockResolvedValue(undefined as never);
  vi.mocked(followUpMonitor.reconcileFollowUpSourceEdit).mockResolvedValue(undefined as never);
  mockSlackClient.fetchChannelInfo.mockResolvedValue({
    ok: true,
    channel: { id: "C123", name: "general", is_private: false },
  } as never);
  vi.mocked(channelMetadata.resolveChannelMetadata).mockResolvedValue({
    name: "general",
    conversationType: "public_channel",
  });
  vi.mocked(slackTypes.isBotJoinEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isProcessableMessageEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isMessageChangedEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isMessageDeletedEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isReactionAddedEvent).mockReturnValue(false);
  vi.mocked(slackTypes.isReactionRemovedEvent).mockReturnValue(false);
});

describe("Slack Events Route", () => {
  it("responds to url_verification with challenge", async () => {
    const res = await postSlackEvent({
      type: "url_verification",
      challenge: "test-challenge-123",
    });

    expect(res.statusCode).toBe(200);
    expect((res.body as { challenge: string }).challenge).toBe("test-challenge-123");
  });

  it("skips duplicate events", async () => {
    vi.mocked(db.reserveSlackEvent).mockResolvedValue("already_processed" as never);
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-dup",
      event: { type: "message", channel: "C123", user: "U1", text: "hello", ts: "1.1" },
    });

    expect(res.statusCode).toBe(200);
    expect(boss.enqueueMessageIngest).not.toHaveBeenCalled();
  });

  it("triggers backfill on bot join", async () => {
    vi.mocked(slackTypes.isBotJoinEvent).mockReturnValue(true);
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-join",
      event: { type: "member_joined_channel", channel: "C456", user: "UBOT123", ts: "1.2" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.upsertChannel).toHaveBeenCalledWith(
      expect.any(String),
      "C456",
      "pending",
      "general",
      "public_channel",
    );
    expect(eventBus.eventBus.createAndPublish).toHaveBeenCalledWith(
      "channel_status_changed",
      expect.any(String),
      "C456",
      { newStatus: "pending" },
    );
    expect(boss.enqueueBackfill).toHaveBeenCalled();
  });

  it("preserves an existing private channel when metadata lookup fails during bot join", async () => {
    vi.mocked(slackTypes.isBotJoinEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1",
      workspace_id: "default",
      channel_id: "C456",
      name: "sage_team",
      conversation_type: "private_channel",
      status: "failed",
      initialized_at: null,
      last_event_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    vi.mocked(channelMetadata.resolveChannelMetadata).mockResolvedValue(null);
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-private-join",
      event: { type: "member_joined_channel", channel: "C456", user: "UBOT123", ts: "1.25" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.upsertChannel).toHaveBeenCalledWith(
      expect.any(String),
      "C456",
      "pending",
      "sage_team",
      "private_channel",
    );
  });

  it("enqueues message ingest for human message in ready channel", async () => {
    vi.mocked(slackTypes.isProcessableMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: null, conversation_type: "public_channel", status: "ready", initialized_at: new Date(),
      last_event_at: new Date(), created_at: new Date(), updated_at: new Date(),
    });
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-msg",
      event: { type: "message", channel: "C789", user: "U2", text: "test message", ts: "1.3" },
    });

    expect(res.statusCode).toBe(200);
    expect(boss.enqueueMessageIngest).toHaveBeenCalled();
  });

  it("enqueues ingest and backfill when channel is pending", async () => {
    vi.mocked(slackTypes.isProcessableMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: "general", conversation_type: "public_channel", status: "pending", initialized_at: null,
      last_event_at: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-pending",
      event: { type: "message", channel: "C789", user: "U4", text: "hello pending", ts: "1.31" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.updateChannelStatus).toHaveBeenCalledWith(expect.any(String), "C789", "pending");
    expect(boss.enqueueBackfill).toHaveBeenCalledWith(expect.any(String), "C789", "pending_message_recovery");
    expect(boss.enqueueMessageIngest).toHaveBeenCalled();
  });

  it("re-queues backfill when a failed channel receives a new human message", async () => {
    vi.mocked(slackTypes.isProcessableMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: "sage_team", conversation_type: "public_channel", status: "failed", initialized_at: null,
      last_event_at: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-failed",
      event: { type: "message", channel: "C789", user: "U9", text: "recover this", ts: "1.41" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.updateChannelStatus).toHaveBeenCalledWith(expect.any(String), "C789", "pending");
    expect(boss.enqueueBackfill).toHaveBeenCalledWith(expect.any(String), "C789", "failed_message_recovery");
    expect(boss.enqueueMessageIngest).toHaveBeenCalled();
  });

  it("enqueues message ingest when channel is initializing", async () => {
    vi.mocked(slackTypes.isProcessableMessageEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1", workspace_id: "default", channel_id: "C789",
      name: null, conversation_type: "public_channel", status: "initializing", initialized_at: null,
      last_event_at: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-init",
      event: { type: "message", channel: "C789", user: "U3", text: "during init", ts: "1.4" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.upsertMessage).not.toHaveBeenCalled();
    expect(boss.enqueueMessageIngest).toHaveBeenCalled();
  });

  it("marks open follow-ups as acknowledged on a soft acknowledgment reaction", async () => {
    vi.mocked(slackTypes.isReactionAddedEvent).mockReturnValue(true);
    vi.mocked(db.listOpenFollowUpsBySourceMessage).mockResolvedValue([
      {
        id: "fu-1",
        workspace_id: "default",
        channel_id: "C789",
        source_message_ts: "1710000000.000100",
        source_thread_ts: null,
        requester_user_id: "U-requester",
        status: "open",
        workflow_state: "awaiting_primary",
        seriousness: "medium",
        seriousness_score: 4,
        detection_mode: "heuristic",
        reason_codes: ["request_language"],
        summary: "Needs a reply.",
        due_at: new Date("2026-03-18T00:00:00.000Z"),
        primary_responder_ids: ["U-helper"],
        escalation_responder_ids: ["U-senior"],
        last_alerted_at: null,
        alert_count: 1,
        last_request_ts: "1710000000.000100",
        repeated_ask_count: 1,
        acknowledged_at: null,
        acknowledged_by_user_id: null,
        acknowledgment_source: null,
        engaged_at: null,
        escalated_at: null,
        ignored_score: 0,
        resolved_via_escalation: false,
        primary_missed_sla: false,
        visibility_after: new Date("2026-03-18T00:00:00.000Z"),
        last_responder_user_id: null,
        last_responder_message_ts: null,
        next_expected_response_at: new Date("2026-03-18T06:00:00.000Z"),
        resolved_at: null,
        resolved_message_ts: null,
        resolution_reason: null,
        resolution_scope: null,
        resolved_by_user_id: null,
        last_engagement_at: null,
        dismissed_at: null,
        metadata_json: {},
        snoozed_until: null,
        last_dm_refs: [],
        created_at: new Date("2026-03-18T00:00:00.000Z"),
        updated_at: new Date("2026-03-18T00:00:00.000Z"),
      },
    ] as never);

    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-react",
      event: {
        type: "reaction_added",
        user: "U-helper",
        reaction: "white_check_mark",
        item: { channel: "C789", ts: "1710000000.000100" },
        event_ts: "1710000001.000200",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.listOpenFollowUpsBySourceMessage).toHaveBeenCalledWith(
      "default",
      "C789",
      "1710000000.000100",
    );
    expect(followUpReminderDms.clearFollowUpReminderDms).toHaveBeenCalledWith("default", "fu-1");
    expect(db.acknowledgeFollowUpItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "fu-1",
        acknowledgedByUserId: "U-helper",
        acknowledgmentSource: "reaction",
        responderMessageTs: "1710000000.000100",
        dueAt: expect.any(Date),
      }),
    );
    expect(followUpEvents.emitFollowUpAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        channelId: "C789",
        followUpItemId: "fu-1",
        alertType: "follow_up_acknowledged",
        changeType: "acknowledged",
        summary: "Soft acknowledgment via :white_check_mark: reaction",
      }),
    );
  });

  it("lets the requester soft-acknowledge without resolving the follow-up", async () => {
    vi.mocked(slackTypes.isReactionAddedEvent).mockReturnValue(true);
    vi.mocked(db.listOpenFollowUpsBySourceMessage).mockResolvedValue([
      {
        id: "fu-2",
        workspace_id: "default",
        channel_id: "C789",
        source_message_ts: "1710000000.000100",
        source_thread_ts: null,
        requester_user_id: "U-requester",
        status: "open",
        workflow_state: "awaiting_primary",
        seriousness: "medium",
        seriousness_score: 4,
        detection_mode: "heuristic",
        reason_codes: ["request_language"],
        summary: "Needs a reply.",
        due_at: new Date("2026-03-18T00:00:00.000Z"),
        primary_responder_ids: ["U-helper"],
        escalation_responder_ids: ["U-senior"],
        last_alerted_at: null,
        alert_count: 1,
        last_request_ts: "1710000000.000100",
        repeated_ask_count: 1,
        acknowledged_at: null,
        acknowledged_by_user_id: null,
        acknowledgment_source: null,
        engaged_at: null,
        escalated_at: null,
        ignored_score: 0,
        resolved_via_escalation: false,
        primary_missed_sla: false,
        visibility_after: new Date("2026-03-18T00:00:00.000Z"),
        last_responder_user_id: null,
        last_responder_message_ts: null,
        next_expected_response_at: new Date("2026-03-18T06:00:00.000Z"),
        resolved_at: null,
        resolved_message_ts: null,
        resolution_reason: null,
        resolution_scope: null,
        resolved_by_user_id: null,
        last_engagement_at: null,
        dismissed_at: null,
        metadata_json: {},
        snoozed_until: null,
        last_dm_refs: [],
        created_at: new Date("2026-03-18T00:00:00.000Z"),
        updated_at: new Date("2026-03-18T00:00:00.000Z"),
      },
    ] as never);

    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-react-self",
      event: {
        type: "reaction_added",
        user: "U-requester",
        reaction: "+1",
        item: { channel: "C789", ts: "1710000000.000100" },
        event_ts: "1710000002.000300",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.acknowledgeFollowUpItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "fu-2",
        acknowledgedByUserId: "U-requester",
        acknowledgmentSource: "reaction",
      }),
    );
    expect(followUpReminderDms.clearFollowUpReminderDms).toHaveBeenCalledWith("default", "fu-2");
  });

  it("reprocesses edited human messages for follow-up and analysis reconciliation", async () => {
    vi.mocked(slackTypes.isMessageChangedEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1",
      workspace_id: "default",
      channel_id: "C789",
      name: "sage_team",
      conversation_type: "public_channel",
      status: "ready",
      initialized_at: new Date(),
      last_event_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    } as never);
    vi.mocked(db.replaceMessageContent).mockResolvedValue({
      id: "msg-1",
      workspace_id: "default",
      channel_id: "C789",
      ts: "1710000000.000100",
      thread_ts: null,
      user_id: "U2",
      text: "Can you send the update today?",
      normalized_text: null,
      subtype: null,
      bot_id: null,
      source: "realtime",
      analysis_status: "pending",
      files_json: null,
      links_json: null,
      created_at: new Date(),
      updated_at: new Date(),
    } as never);

    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-edit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C789",
        message: {
          type: "message",
          user: "U2",
          text: "Can you send the update today?",
          ts: "1710000000.000100",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.replaceMessageContent).toHaveBeenCalled();
    expect(db.updateNormalizedText).toHaveBeenCalledWith(
      "default",
      "C789",
      "1710000000.000100",
      expect.any(String),
    );
    expect(db.deleteMessageAnalytics).toHaveBeenCalledWith(
      "default",
      "C789",
      "1710000000.000100",
    );
    expect(followUpMonitor.reconcileFollowUpSourceEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        channelId: "C789",
        ts: "1710000000.000100",
        userId: "U2",
      }),
    );
    expect(boss.enqueueLLMAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        channelId: "C789",
        triggerType: "manual",
        targetMessageTs: ["1710000000.000100"],
      }),
    );
  });

  it("reopens reaction-based acknowledgments when the ack reaction is removed", async () => {
    vi.mocked(slackTypes.isReactionRemovedEvent).mockReturnValue(true);
    vi.mocked(db.listOpenFollowUpsBySourceMessage).mockResolvedValue([
      buildFollowUpItem({
        id: "fu-react",
        workflow_state: "acknowledged_waiting",
        acknowledgment_source: "reaction",
      }),
    ] as never);

    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-react-removed",
      event: {
        type: "reaction_removed",
        user: "U-helper",
        reaction: "white_check_mark",
        item: { type: "message", channel: "C789", ts: "1710000000.000100" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.reopenFollowUpItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "fu-react",
        workflowState: "awaiting_primary",
      }),
    );
    expect(followUpEvents.emitFollowUpAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpItemId: "fu-react",
        changeType: "reopened",
      }),
    );
  });

  it("dismisses source follow-ups and reopens reply-based resolutions when a message is deleted", async () => {
    vi.mocked(slackTypes.isMessageDeletedEvent).mockReturnValue(true);
    vi.mocked(db.getChannel).mockResolvedValue({
      id: "uuid-1",
      workspace_id: "default",
      channel_id: "C789",
      name: "sage_team",
      conversation_type: "public_channel",
      status: "ready",
      initialized_at: new Date(),
      last_event_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    } as never);
    vi.mocked(db.getOpenFollowUpBySourceMessage).mockResolvedValue(
      buildFollowUpItem({ id: "fu-source" }) as never,
    );
    vi.mocked(db.listResolvedFollowUpsByResolvedMessage).mockResolvedValue([
      buildFollowUpItem({
        id: "fu-resolved",
        status: "resolved",
        workflow_state: "resolved",
        resolved_message_ts: "1710000000.000100",
        resolution_reason: "reply",
      }),
    ] as never);

    const res = await postSlackEvent({
      type: "event_callback",
      team_id: "default",
      event_id: "ev-delete",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C789",
        deleted_ts: "1710000000.000100",
        previous_message: {
          user: "U-helper",
          ts: "1710000000.000100",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.markMessageDeleted).toHaveBeenCalledWith(
      "default",
      "C789",
      "1710000000.000100",
    );
    expect(db.dismissFollowUpItem).toHaveBeenCalledWith("fu-source", "U-helper");
    expect(db.reopenFollowUpItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "fu-resolved",
      }),
    );
    expect(followUpEvents.emitFollowUpAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpItemId: "fu-source",
        alertType: "follow_up_dismissed",
      }),
    );
  });
});
