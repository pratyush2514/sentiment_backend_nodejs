export interface BackfillJob {
  workspaceId: string;
  channelId: string;
  reason: string;
}

export interface SlackFileMetadata {
  name: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  permalink?: string;
}

export interface MessageIngestJob {
  workspaceId: string;
  channelId: string;
  ts: string;
  userId: string;
  text: string;
  threadTs: string | null;
  eventId: string;
  subtype?: string | null;
  botId?: string | null;
  files?: SlackFileMetadata[];
}

export interface UserResolveJob {
  workspaceId: string;
  userId: string;
}

export interface ThreadReconcileJob {
  workspaceId: string;
  channelId: string;
}

export interface LLMAnalyzeJob {
  workspaceId: string;
  channelId: string;
  triggerType: "risk" | "threshold" | "time" | "manual";
  mode?: "latest" | "visible_messages" | "thread_messages";
  threadTs?: string | null;
  targetMessageTs?: string[] | null;
  /** When true, analysis results are saved but alerts/DMs/follow-ups are suppressed.
   *  Used by seedInitialAnalytics after backfill to populate data without spamming. */
  suppressAlerts?: boolean;
}

export type SummaryRollupRequestedBy =
  | "message_ingest"
  | "state_route"
  | "messages_route"
  | "threads_route"
  | "alerts_route"
  | "manual"
  | "backfill";

export interface SummaryRollupJob {
  workspaceId: string;
  channelId: string;
  rollupType: "channel" | "thread" | "backfill";
  threadTs?: string | null;
  requestedBy?: SummaryRollupRequestedBy;
}

export interface ChannelDiscoveryJob {
  workspaceId: string;
  reason: "install" | "login" | "manual";
}

export interface QueueRuntimeOptions {
  registerWorkers?: boolean;
}

export const JOB_NAMES = {
  BACKFILL: "channel.backfill",
  MESSAGE_INGEST: "message.ingest",
  USER_RESOLVE: "user.resolve",
  THREAD_RECONCILE: "thread.reconcile",
  LLM_ANALYZE: "llm.analyze",
  SUMMARY_ROLLUP: "summary.rollup",
  CHANNEL_DISCOVERY: "channel.discovery",
} as const;

export const QUEUE_CONFIG = {
  [JOB_NAMES.BACKFILL]: {
    localConcurrency: 2,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 90 * 60,
  },
  [JOB_NAMES.MESSAGE_INGEST]: {
    localConcurrency: 8,
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [JOB_NAMES.USER_RESOLVE]: {
    localConcurrency: 5,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 2 * 60,
  },
  [JOB_NAMES.THREAD_RECONCILE]: {
    localConcurrency: 3,
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
  },
  [JOB_NAMES.LLM_ANALYZE]: {
    localConcurrency: 4,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
  },
  [JOB_NAMES.SUMMARY_ROLLUP]: {
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
  },
  [JOB_NAMES.CHANNEL_DISCOVERY]: {
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
} as const;
