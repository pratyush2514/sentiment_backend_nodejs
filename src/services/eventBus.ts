import { EventEmitter } from "node:events";
import type { DashboardEvent, DashboardEventType } from "../types/database.js";

class DashboardEventBus extends EventEmitter {
  publish(event: DashboardEvent): void {
    this.emit("dashboard_event", event);
  }

  createAndPublish(
    type: DashboardEventType,
    workspaceId: string,
    channelId: string,
    data: Record<string, unknown>,
  ): void {
    this.publish({
      type,
      workspaceId,
      channelId,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

export const eventBus = new DashboardEventBus();
