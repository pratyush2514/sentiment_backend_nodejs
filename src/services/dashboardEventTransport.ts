import crypto from "node:crypto";
import pg from "pg";
import { config } from "../config.js";
import { directPool } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { eventBus, registerDashboardEventDispatcher } from "./eventBus.js";
import type { DashboardEvent, DashboardEventType } from "../types/database.js";

const log = logger.child({ service: "dashboardEventTransport" });
const DASHBOARD_EVENT_CHANNEL = "pulseboard_dashboard_events";
const LISTENER_RECONNECT_MS = 2_000;
const MAX_NOTIFY_PAYLOAD_BYTES = 7_500;
const instanceId = crypto.randomUUID();

type DashboardEventEnvelope = {
  sourceInstanceId: string;
  event: DashboardEvent;
};

let listenerClient: pg.Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldSubscribe = false;
let shuttingDown = false;

function isDashboardEventType(value: unknown): value is DashboardEventType {
  return (
    value === "analysis_completed" ||
    value === "rollup_updated" ||
    value === "channel_status_changed" ||
    value === "alert_triggered" ||
    value === "message_ingested"
  );
}

function isDashboardEvent(value: unknown): value is DashboardEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isDashboardEventType(candidate.type) &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.channelId === "string" &&
    typeof candidate.timestamp === "string" &&
    !!candidate.data &&
    typeof candidate.data === "object" &&
    !Array.isArray(candidate.data)
  );
}

function isDashboardEventEnvelope(value: unknown): value is DashboardEventEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sourceInstanceId === "string" &&
    isDashboardEvent(candidate.event)
  );
}

async function dispatchViaDatabase(event: DashboardEvent): Promise<void> {
  const envelope: DashboardEventEnvelope = {
    sourceInstanceId: instanceId,
    event,
  };
  const payload = JSON.stringify(envelope);
  const payloadBytes = Buffer.byteLength(payload, "utf8");

  if (payloadBytes > MAX_NOTIFY_PAYLOAD_BYTES) {
    log.warn(
      {
        eventType: event.type,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        payloadBytes,
      },
      "Dashboard event payload exceeded pg_notify size budget; delivering locally only",
    );
    eventBus.publishLocal(event);
    return;
  }

  try {
    await directPool.query("SELECT pg_notify($1, $2)", [
      DASHBOARD_EVENT_CHANNEL,
      payload,
    ]);
  } catch (err) {
    log.error(
      {
        err,
        eventType: event.type,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
      },
      "Failed to publish dashboard event through PostgreSQL; delivering locally only",
    );
    eventBus.publishLocal(event);
  }
}

async function cleanupListenerClient(client: pg.Client | null): Promise<void> {
  if (!client) {
    return;
  }

  client.removeAllListeners();
  try {
    await client.end();
  } catch {
    // Ignore cleanup failures during reconnect/shutdown.
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || shuttingDown || !shouldSubscribe) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener().catch((err) => {
      log.error({ err }, "Dashboard event listener reconnect failed");
      scheduleReconnect();
    });
  }, LISTENER_RECONNECT_MS);
}

async function resetListener(reason: string): Promise<void> {
  const client = listenerClient;
  listenerClient = null;
  await cleanupListenerClient(client);

  if (!shuttingDown && shouldSubscribe) {
    log.warn(
      { reason },
      "Dashboard event listener disconnected; scheduling reconnect",
    );
    scheduleReconnect();
  }
}

async function connectListener(): Promise<void> {
  if (listenerClient || shuttingDown || !shouldSubscribe) {
    return;
  }

  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  client.on("notification", (message) => {
    if (message.channel !== DASHBOARD_EVENT_CHANNEL || !message.payload) {
      return;
    }

    try {
      const parsed = JSON.parse(message.payload) as unknown;
      if (!isDashboardEventEnvelope(parsed)) {
        log.warn(
          { payload: message.payload },
          "Ignored malformed dashboard event notification",
        );
        return;
      }

      if (parsed.sourceInstanceId === instanceId) {
        return;
      }

      eventBus.publishLocal(parsed.event);
    } catch (err) {
      log.warn(
        { err, payload: message.payload },
        "Failed to parse dashboard event notification",
      );
    }
  });

  client.on("error", (err) => {
    log.error({ err }, "Dashboard event listener error");
    void resetListener("client_error");
  });

  client.on("end", () => {
    void resetListener("client_end");
  });

  await client.connect();
  await client.query(`LISTEN ${DASHBOARD_EVENT_CHANNEL}`);
  listenerClient = client;
  log.info(
    { channel: DASHBOARD_EVENT_CHANNEL },
    "Dashboard event listener subscribed",
  );
}

export async function startDashboardEventTransport(options: {
  subscribe: boolean;
}): Promise<void> {
  shuttingDown = false;
  shouldSubscribe = options.subscribe;
  registerDashboardEventDispatcher(dispatchViaDatabase);

  if (!shouldSubscribe) {
    return;
  }

  await connectListener();
}

export async function stopDashboardEventTransport(): Promise<void> {
  shuttingDown = true;
  shouldSubscribe = false;
  registerDashboardEventDispatcher(null);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const client = listenerClient;
  listenerClient = null;
  await cleanupListenerClient(client);
}
