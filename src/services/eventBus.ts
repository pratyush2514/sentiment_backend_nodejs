import { EventEmitter } from "node:events";
import type { DashboardEvent, DashboardEventType } from "../types/database.js";

type DashboardEventDispatcher = (event: DashboardEvent) => Promise<void>;

let dispatchDashboardEvent: DashboardEventDispatcher | null = null;

export function registerDashboardEventDispatcher(
  dispatcher: DashboardEventDispatcher | null,
): void {
  dispatchDashboardEvent = dispatcher;
}

class DashboardEventBus extends EventEmitter {
  publishLocal(event: DashboardEvent): void {
    this.emit("dashboard_event", event);
  }

  createAndPublish(
    type: DashboardEventType,
    workspaceId: string,
    channelId: string,
    data: Record<string, unknown>,
  ): void {
    const event: DashboardEvent = {
      type,
      workspaceId,
      channelId,
      data,
      timestamp: new Date().toISOString(),
    };

    if (dispatchDashboardEvent) {
      void dispatchDashboardEvent(event);
      return;
    }

    this.publishLocal(event);
  }
}

export const eventBus = new DashboardEventBus();
