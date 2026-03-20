import { config } from "../config.js";

export interface RuntimeStateSnapshot {
  role: typeof config.RUNTIME_ROLE;
  httpServing: boolean;
  schedulerRunning: boolean;
  queueStarted: boolean;
  workersRegistered: boolean;
  lastQueueStartedAt: string | null;
  lastWorkersRegisteredAt: string | null;
}

const runtimeState: RuntimeStateSnapshot = {
  role: config.RUNTIME_ROLE,
  httpServing: false,
  schedulerRunning: false,
  queueStarted: false,
  workersRegistered: false,
  lastQueueStartedAt: null,
  lastWorkersRegisteredAt: null,
};

export function markHttpServing(value: boolean): void {
  runtimeState.httpServing = value;
}

export function markSchedulerRunning(value: boolean): void {
  runtimeState.schedulerRunning = value;
}

export function markQueueRuntimeState(input: {
  queueStarted: boolean;
  workersRegistered: boolean;
}): void {
  runtimeState.queueStarted = input.queueStarted;
  runtimeState.workersRegistered = input.workersRegistered;

  const now = new Date().toISOString();
  if (input.queueStarted) {
    runtimeState.lastQueueStartedAt = now;
  }
  if (input.workersRegistered) {
    runtimeState.lastWorkersRegisteredAt = now;
  }
}

export function getRuntimeState(): RuntimeStateSnapshot {
  return { ...runtimeState };
}
