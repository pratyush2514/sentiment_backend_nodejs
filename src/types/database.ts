export type ChannelStatus = "pending" | "initializing" | "ready" | "failed";

export type MessageSource = "realtime" | "backfill";

export type AnalysisStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export interface ChannelRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  name: string | null;
  status: ChannelStatus;
  initialized_at: Date | null;
  last_event_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SlackEventRow {
  id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  received_at: Date;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string;
  text: string;
  normalized_text: string | null;
  subtype: string | null;
  bot_id: string | null;
  source: MessageSource;
  analysis_status: AnalysisStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadEdgeRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  child_ts: string;
  created_at: Date;
}

export interface UserProfileRow {
  id: string;
  workspace_id: string;
  user_id: string;
  display_name: string | null;
  real_name: string | null;
  profile_image: string | null;
  fetched_at: Date;
}

export type DominantEmotion =
  | "anger"
  | "disgust"
  | "fear"
  | "joy"
  | "neutral"
  | "sadness"
  | "surprise";

export type EscalationRisk = "low" | "medium" | "high";

export interface MessageAnalyticsRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_ts: string;
  dominant_emotion: DominantEmotion;
  confidence: number;
  escalation_risk: EscalationRisk;
  themes: string[];
  decision_signal: boolean;
  explanation: string | null;
  raw_llm_response: Record<string, unknown>;
  llm_provider: string;
  llm_model: string;
  token_usage: Record<string, unknown> | null;
  created_at: Date;
}

export type ContextDocType = "channel_rollup" | "thread_rollup" | "backfill_rollup";

export interface ContextDocumentRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  doc_type: ContextDocType;
  content: string;
  token_count: number;
  source_ts_start: string | null;
  source_ts_end: string | null;
  source_thread_ts: string | null;
  message_count: number;
  created_at: Date;
}

export interface EnrichedMessageRow extends MessageRow {
  display_name: string | null;
  real_name: string | null;
}

export interface ChannelStateRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  running_summary: string;
  participants_json: Record<string, number>;
  active_threads_json: Array<{
    threadTs: string;
    messageCount: number;
    lastActivityAt: string;
  }>;
  key_decisions_json: string[];
  sentiment_snapshot_json: {
    totalMessages: number;
    highRiskCount: number;
    updatedAt: string;
  };
  messages_since_last_llm: number;
  last_llm_run_at: Date | null;
  llm_cooldown_until: Date | null;
  last_reconcile_at: Date | null;
  messages_since_last_rollup: number;
  last_rollup_at: Date | null;
  updated_at: Date;
}
