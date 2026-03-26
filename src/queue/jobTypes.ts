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

export interface MeetingIngestJob {
  workspaceId: string;
  fathomCallId: string;
  source: "webhook" | "refetch" | "shared_link";
  importMode?: "live" | "historical";
  channelIdHint?: string;
  payload?: Record<string, unknown>;
}

export interface MeetingHistoricalSyncJob {
  workspaceId: string;
  windowDays: number;
  requestedBy: "auto_connect" | "manual" | "maintenance";
}

export interface MeetingExtractJob {
  workspaceId: string;
  meetingId: string;
}

export interface MeetingDigestJob {
  workspaceId: string;
  meetingId: string;
  channelId: string;
}

export interface MeetingObligationSyncJob {
  workspaceId: string;
  meetingId: string;
}

export interface ChannelClassifyJob {
  workspaceId: string;
  channelId: string;
  source: "install" | "reconcile" | "manual" | "startup";
}

// Tiered backfill jobs
export interface BackfillTier1Job {
  workspaceId: string;
  channelId: string;
  reason: string;
}

export interface BackfillTier2Job {
  workspaceId: string;
  channelId: string;
  backfillRunId: string;
  reason: string;
}

export interface BackfillTier3Job {
  workspaceId: string;
  channelId: string;
  backfillRunId: string;
  reason: string;
  /** Oldest message ts fetched in Tier 2, so Tier 3 knows where to start */
  tier2CoverageOldestTs: string | null;
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
  CHANNEL_CLASSIFY: "channel.classify",
  MEETING_INGEST: "meeting.ingest",
  MEETING_HISTORICAL_SYNC: "meeting.historical_sync",
  MEETING_EXTRACT: "meeting.extract",
  MEETING_DIGEST: "meeting.digest",
  MEETING_OBLIGATION_SYNC: "meeting.obligation_sync",
  BACKFILL_TIER1: "backfill.tier1_bootstrap",
  BACKFILL_TIER2: "backfill.tier2_recent",
  BACKFILL_TIER3: "backfill.tier3_deep",
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
  [JOB_NAMES.CHANNEL_CLASSIFY]: {
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [JOB_NAMES.MEETING_INGEST]: {
    localConcurrency: 2,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 10 * 60,
  },
  [JOB_NAMES.MEETING_HISTORICAL_SYNC]: {
    localConcurrency: 1,
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
  },
  [JOB_NAMES.MEETING_EXTRACT]: {
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
  },
  [JOB_NAMES.MEETING_DIGEST]: {
    localConcurrency: 3,
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  [JOB_NAMES.MEETING_OBLIGATION_SYNC]: {
    localConcurrency: 2,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 10 * 60,
  },
  [JOB_NAMES.BACKFILL_TIER1]: {
    localConcurrency: 4,
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 30,
  },
  [JOB_NAMES.BACKFILL_TIER2]: {
    localConcurrency: 3,
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [JOB_NAMES.BACKFILL_TIER3]: {
    localConcurrency: 2,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 90 * 60,
  },
} as const;
