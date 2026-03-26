import type {
  EmotionalTemperature as ContractEmotionalTemperature,
  ThreadOperationalRisk as ContractThreadOperationalRisk,
  ThreadState as ContractThreadState,
} from "../contracts/threadRollup.js";

export type ChannelStatus = "pending" | "initializing" | "ready" | "failed";
export type ConversationType = "public_channel" | "private_channel" | "dm" | "group_dm";
export type ImportanceTierOverride = "auto" | "high_value" | "standard" | "low_value";
export type ImportanceTier = Exclude<ImportanceTierOverride, "auto">;
export type ChannelModeOverride = "auto" | "collaboration" | "automation" | "mixed";
export type ChannelMode = Exclude<ChannelModeOverride, "auto">;
export type WorkspaceInstallStatus = "active" | "uninstalled";
export type WorkspaceTokenRotationStatus =
  | "ready"
  | "legacy_reinstall_required"
  | "refresh_failed"
  | "expired_or_invalid";
export type UserRole = "client" | "worker" | "senior" | "observer";
export type RoleAssignmentSource = "manual" | "inferred";
export type RoleReviewState = "suggested" | "confirmed" | "rejected";

export type MessageSource = "realtime" | "backfill";

export type AnalysisStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export type MessageIntelligenceEligibilityStatus =
  | "eligible"
  | "not_candidate"
  | "policy_suppressed"
  | "privacy_suppressed";

export type MessageIntelligenceExecutionStatus =
  | "not_run"
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export type MessageIntelligenceQualityStatus =
  | "none"
  | "fallback"
  | "partial"
  | "verified";

export type MessageIntelligenceSuppressionReason =
  | "channel_not_ready"
  | "cooldown"
  | "importance_tier"
  | "privacy_skip"
  | "budget_exceeded"
  | "not_candidate";

export type SummaryArtifactKind =
  | "channel_rollup"
  | "thread_rollup"
  | "backfill_rollup";

export type SummaryArtifactGenerationMode = "llm" | "fallback" | "reused_existing";

export type SummaryArtifactCompletenessStatus =
  | "complete"
  | "partial"
  | "stale"
  | "no_recent_messages";

export type BackfillRunStatus =
  | "running"
  | "completed"
  | "completed_with_degradations"
  | "failed";

export type BackfillRunPhase =
  | "history_import"
  | "thread_expansion"
  | "user_enrichment"
  | "member_sync"
  | "initial_intelligence"
  | "finalize";

export type BackfillMemberSyncResult =
  | "not_started"
  | "running"
  | "succeeded"
  | "degraded"
  | "failed";

export type IngestReadiness = "not_started" | "hydrating" | "ready";
export type IntelligenceReadiness = "missing" | "bootstrap" | "partial" | "ready" | "stale";

export type IntelligenceDegradationScopeType =
  | "channel"
  | "message"
  | "thread"
  | "summary_artifact"
  | "backfill_run"
  | "meeting";

export type IntelligenceDegradationType =
  | "embedding_failure"
  | "thread_fetch_skipped"
  | "metadata_resolution_failure"
  | "thread_insight_enqueue_failure"
  | "budget_truncation"
  | "budget_truncated"
  | "provider_validation_retry_exhaustion"
  | "unresolved_target_users"
  | "partial_thread_fetch"
  | "incomplete_persisted_analysis"
  | "budget_exceeded"
  | "embedding_failed"
  | "thread_fetch_failed"
  | "member_sync_failed"
  | "analysis_failed"
  | "analysis_threw_unexpected_error"
  | "incomplete_persisted_analysis_recovered"
  | "low_signal_channel"
  | "meta_summary_fallback"
  | "fathom_fetch_failed"
  | "fathom_extraction_failed"
  | "fathom_digest_failed"
  | "fathom_channel_link_missing"
  | "meeting_participant_resolution_failed";

export type IntelligenceDegradationSeverity = "info" | "warning" | "error";

export interface ChannelRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  name: string | null;
  conversation_type: ConversationType;
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
  files_json: Array<{ name: string; title?: string; mimetype?: string; filetype?: string; size?: number; permalink?: string }> | null;
  links_json: Array<{ url: string; domain: string; label?: string; linkType: string }> | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageIntelligenceStateRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_ts: string;
  eligibility_status: MessageIntelligenceEligibilityStatus;
  execution_status: MessageIntelligenceExecutionStatus;
  quality_status: MessageIntelligenceQualityStatus;
  suppression_reason: MessageIntelligenceSuppressionReason | null;
  provider_name: string | null;
  provider_model: string | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  completed_at: Date | null;
  recovered_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type SummaryFactKind =
  | "topic"
  | "blocker"
  | "resolution"
  | "decision"
  | "primary_issue"
  | "open_question";

export interface SummaryFactEvidence {
  messageTs: string;
  threadTs: string | null;
  excerpt: string | null;
}

export interface SummaryFact {
  kind: SummaryFactKind;
  text: string;
  evidence: SummaryFactEvidence[];
}

export interface SummaryArtifactRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  summary_kind: SummaryArtifactKind;
  generation_mode: SummaryArtifactGenerationMode;
  completeness_status: SummaryArtifactCompletenessStatus;
  summary: string;
  key_decisions_json: string[];
  summary_facts_json: SummaryFact[];
  degraded_reasons_json: string[];
  coverage_start_ts: string | null;
  coverage_end_ts: string | null;
  candidate_message_count: number;
  included_message_count: number;
  artifact_version: number;
  source_run_id: string | null;
  superseded_at: Date | null;
  superseded_by_artifact_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BackfillRunRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  status: BackfillRunStatus;
  current_phase: BackfillRunPhase;
  pages_fetched: number;
  messages_imported: number;
  thread_roots_discovered: number;
  threads_attempted: number;
  threads_failed: number;
  users_resolved: number;
  member_sync_result: BackfillMemberSyncResult;
  summary_artifact_id: string | null;
  degraded_reason_count: number;
  last_error: string | null;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface IntelligenceDegradationEventRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  scope_type: IntelligenceDegradationScopeType;
  scope_key: string | null;
  message_ts: string | null;
  thread_ts: string | null;
  summary_artifact_id: string | null;
  backfill_run_id: string | null;
  degradation_type: IntelligenceDegradationType;
  severity: IntelligenceDegradationSeverity;
  details_json: Record<string, unknown>;
  dedupe_key: string | null;
  is_active: boolean;
  superseded_by_event_id: string | null;
  resolved_at: Date | null;
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
  email: string | null;
  is_admin: boolean;
  is_owner: boolean;
  is_bot: boolean;
  fetched_at: Date;
}

export interface FollowUpRuleRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  conversation_type: ConversationType;
  enabled: boolean;
  sla_hours: number;
  analysis_window_days: number;
  owner_user_ids: string[];
  client_user_ids: string[];
  senior_user_ids: string[];
  importance_tier_override: ImportanceTierOverride;
  channel_mode_override: ChannelModeOverride;
  slack_notifications_enabled: boolean;
  muted: boolean;
  privacy_opt_in: boolean;
  created_at: Date;
  updated_at: Date;
}

export type FollowUpStatus = "open" | "resolved" | "dismissed";
export type FollowUpSeriousness = "low" | "medium" | "high";
export type FollowUpDetectionMode = "heuristic" | "rule" | "hybrid" | "llm" | "meeting";
export type FollowUpWorkflowState =
  | "pending_reply_window"
  | "awaiting_primary"
  | "acknowledged_waiting"
  | "escalated"
  | "resolved"
  | "dismissed"
  | "expired";
export type FollowUpAcknowledgmentSource =
  | "message"
  | "reaction"
  | "manual"
  | "system";
export type FollowUpResolutionReason =
  | "reply"
  | "reaction_ack"
  | "requester_ack"
  | "natural_conclusion"
  | "manual_done"
  | "manual_dismissed"
  | "expired";
export type FollowUpResolutionScope =
  | "thread"
  | "channel"
  | "reaction"
  | "manual"
  | "system";

export interface FollowUpItemRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  source_message_ts: string;
  source_thread_ts: string | null;
  requester_user_id: string;
  status: FollowUpStatus;
  workflow_state: FollowUpWorkflowState;
  seriousness: FollowUpSeriousness;
  seriousness_score: number;
  detection_mode: FollowUpDetectionMode;
  reason_codes: string[];
  summary: string;
  due_at: Date;
  primary_responder_ids: string[];
  escalation_responder_ids: string[];
  last_alerted_at: Date | null;
  alert_count: number;
  last_request_ts: string | null;
  repeated_ask_count: number;
  acknowledged_at: Date | null;
  acknowledged_by_user_id: string | null;
  acknowledgment_source: FollowUpAcknowledgmentSource | null;
  engaged_at: Date | null;
  escalated_at: Date | null;
  ignored_score: number;
  resolved_via_escalation: boolean;
  primary_missed_sla: boolean;
  visibility_after: Date | null;
  last_responder_user_id: string | null;
  last_responder_message_ts: string | null;
  next_expected_response_at: Date | null;
  resolved_at: Date | null;
  resolved_message_ts: string | null;
  resolution_reason: FollowUpResolutionReason | null;
  resolution_scope: FollowUpResolutionScope | null;
  resolved_by_user_id: string | null;
  last_engagement_at: Date | null;
  dismissed_at: Date | null;
  metadata_json: Record<string, unknown>;
  snoozed_until: Date | null;
  last_dm_refs: { userId: string; dmChannelId: string; messageTs: string }[];
  created_at: Date;
  updated_at: Date;
}

export interface RoleAssignmentRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: UserRole;
  source: RoleAssignmentSource;
  review_state: RoleReviewState;
  confidence: number;
  reasons_json: string[];
  display_label: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FollowUpEventRow {
  id: string;
  follow_up_item_id: string;
  workspace_id: string;
  channel_id: string;
  event_type:
    | "created"
    | "acknowledged"
    | "escalated"
    | "resolved"
    | "reopened"
    | "snoozed"
    | "dismissed"
    | "expired";
  workflow_state: FollowUpWorkflowState | null;
  actor_user_id: string | null;
  message_ts: string | null;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

export interface ChannelMemberRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  user_id: string;
  fetched_at: Date;
  created_at: Date;
}

export type DominantEmotion =
  | "anger"
  | "disgust"
  | "fear"
  | "joy"
  | "neutral"
  | "sadness"
  | "surprise";

export type InteractionTone =
  | "neutral"
  | "collaborative"
  | "corrective"
  | "tense"
  | "confrontational"
  | "dismissive";

export type EscalationRisk = "low" | "medium" | "high";

export type MessageCandidateKind =
  | "ignore"
  | "context_only"
  | "message_candidate"
  | "thread_turning_point"
  | "resolution_signal";

export type CanonicalSignalType =
  | "ignore"
  | "context"
  | "request"
  | "decision"
  | "resolution"
  | "human_risk"
  | "operational_incident";

export type CanonicalSignalSeverity = "none" | "low" | "medium" | "high";

export type SignalStateImpact =
  | "none"
  | "issue_opened"
  | "blocked"
  | "investigating"
  | "resolved"
  | "escalated";

export type EvidenceType = "heuristic" | "llm_enriched" | "rollup_derived";
export type OriginType = "human" | "bot" | "system";
export type IncidentFamily =
  | "none"
  | "workflow_error"
  | "execution_failure"
  | "data_shape_error"
  | "timeout"
  | "http_error"
  | "infra_error"
  | "unknown";

export type SurfacePriority = "none" | "low" | "medium" | "high";

export type StateTransition =
  | "issue_opened"
  | "investigating"
  | "blocked"
  | "waiting_external"
  | "ownership_assigned"
  | "decision_made"
  | "resolved"
  | "escalated";

export type ThreadState = ContractThreadState;
export type EmotionalTemperature = ContractEmotionalTemperature;
export type OperationalRisk = ContractThreadOperationalRisk;

export interface MessageTriageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_ts: string;
  candidate_kind: MessageCandidateKind;
  surface_priority: SurfacePriority;
  candidate_score: number;
  state_transition: StateTransition | null;
  signal_type: CanonicalSignalType;
  severity: CanonicalSignalSeverity;
  state_impact: SignalStateImpact;
  evidence_type: EvidenceType;
  channel_mode: ChannelMode;
  origin_type: OriginType;
  confidence: number;
  incident_family: IncidentFamily;
  reason_codes: string[];
  signals_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface RiskDriver {
  key: string;
  label: string;
  message: string;
  severity: CanonicalSignalSeverity;
  category: "human" | "operational" | "thread" | "alert" | "summary";
}

export interface AttentionSummary {
  status: "clear" | "watch" | "action";
  title: string;
  message: string;
  driverKeys: string[];
}

export interface MessageDispositionCounts {
  totalInWindow: number;
  deepAiAnalyzed: number;
  heuristicIncidentSignals: number;
  contextOnly: number;
  routineAcknowledgments: number;
  storedWithoutDeepAnalysis: number;
  inFlight: number;
}

export interface RelatedIncidentMentionRow {
  message_ts: string;
  source_channel_name: string | null;
  source_channel_id: string | null;
  message_text: string;
  detected_at: string | null;
  blocks_local_work: boolean;
  incident_family: IncidentFamily;
}

export interface CrucialMoment {
  messageTs: string;
  kind: string;
  reason: string;
  surfacePriority: SurfacePriority;
}

export interface ThreadInsightRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  summary: string;
  primary_issue: string;
  thread_state: ThreadState;
  emotional_temperature: EmotionalTemperature;
  operational_risk: OperationalRisk;
  surface_priority: SurfacePriority;
  crucial_moments_json: CrucialMoment[];
  open_questions_json: string[];
  last_meaningful_change_ts: string | null;
  source_ts_end: string | null;
  raw_llm_response: Record<string, unknown>;
  llm_provider: string;
  llm_model: string;
  token_usage: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageAnalyticsRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_ts: string;
  dominant_emotion: DominantEmotion;
  interaction_tone: InteractionTone | null;
  confidence: number;
  escalation_risk: EscalationRisk;
  themes: string[];
  decision_signal: boolean;
  explanation: string | null;
  raw_llm_response: Record<string, unknown>;
  llm_provider: string;
  llm_model: string;
  token_usage: Record<string, unknown> | null;
  message_intent: string | null;
  is_actionable: boolean | null;
  is_blocking: boolean;
  urgency_level: string;
  created_at: Date;
}

export type MessageIntent =
  | "request"
  | "question"
  | "decision"
  | "commitment"
  | "blocker"
  | "escalation"
  | "fyi"
  | "acknowledgment";

export type UrgencyLevel = "none" | "low" | "medium" | "high" | "critical";

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
  summary_artifact_id: string | null;
  created_at: Date;
}

export interface EnrichedMessageRow extends MessageRow {
  display_name: string | null;
  real_name: string | null;
}

export interface ChannelOverviewRow {
  channel_id: string;
  name: string | null;
  conversation_type: ConversationType;
  status: ChannelStatus;
  initialized_at: Date | null;
  last_event_at: Date | null;
  updated_at: Date;
  running_summary: string | null;
  ingest_readiness?: IngestReadiness | null;
  intelligence_readiness?: IntelligenceReadiness | null;
  current_summary_artifact_id?: string | null;
  active_backfill_run_id?: string | null;
  active_degradation_count?: number | null;
  latest_summary_completeness?: SummaryArtifactCompletenessStatus | null;
  has_active_degradations?: boolean | null;
  sentiment_snapshot_json: Record<string, unknown> | null;
  signal: "stable" | "elevated" | "escalating" | null;
  health: "healthy" | "attention" | "at-risk" | null;
  signal_confidence: number | null;
  risk_drivers_json: RiskDriver[] | null;
  attention_summary_json: AttentionSummary | null;
  message_disposition_counts_json: MessageDispositionCounts | null;
  effective_channel_mode: ChannelMode | null;
  message_count: string;
  active_message_count: string;
  total_imported_message_count: string;
}

export interface EnrichedMessageWithAnalyticsRow extends EnrichedMessageRow {
  intelligence_state_id: string | null;
  analysis_eligibility: MessageIntelligenceEligibilityStatus | null;
  analysis_execution: MessageIntelligenceExecutionStatus | null;
  analysis_quality: MessageIntelligenceQualityStatus | null;
  suppression_reason: MessageIntelligenceSuppressionReason | null;
  analysis_provider_name: string | null;
  analysis_provider_model: string | null;
  analysis_attempt_count: number | null;
  analysis_last_attempt_at: Date | null;
  analysis_completed_at: Date | null;
  analysis_recovered_at: Date | null;
  analysis_last_error: string | null;
  ma_dominant_emotion: DominantEmotion | null;
  ma_interaction_tone: InteractionTone | null;
  ma_confidence: number | null;
  ma_escalation_risk: EscalationRisk | null;
  ma_explanation: string | null;
  ma_themes: string[] | null;
  ma_raw_llm_response: Record<string, unknown> | null;
  ma_message_intent: string | null;
  ma_is_actionable: boolean | null;
  ma_is_blocking: boolean | null;
  ma_urgency_level: string | null;
  fu_id: string | null;
  fu_seriousness: FollowUpSeriousness | null;
  fu_summary: string | null;
  fu_due_at: Date | null;
  fu_repeated_ask_count: number | null;
  mt_candidate_kind: MessageCandidateKind | null;
  mt_signal_type: CanonicalSignalType | null;
  mt_severity: CanonicalSignalSeverity | null;
  mt_state_impact: SignalStateImpact | null;
  mt_evidence_type: EvidenceType | null;
  mt_channel_mode: ChannelMode | null;
  mt_origin_type: OriginType | null;
  mt_confidence: number | null;
  mt_incident_family: IncidentFamily | null;
  mt_surface_priority: SurfacePriority | null;
  mt_reason_codes: string[] | null;
  mt_state_transition: StateTransition | null;
  mt_signals_json: Record<string, unknown> | null;
}

export type DashboardEventType =
  | "analysis_completed"
  | "rollup_updated"
  | "channel_status_changed"
  | "alert_triggered"
  | "message_ingested";

export interface DashboardEvent {
  type: DashboardEventType;
  workspaceId: string;
  channelId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface WorkspaceRow {
  workspace_id: string;
  team_name: string | null;
  bot_token_encrypted: Buffer;
  bot_token_iv: Buffer;
  bot_token_tag: Buffer;
  bot_refresh_token_encrypted: Buffer | null;
  bot_refresh_token_iv: Buffer | null;
  bot_refresh_token_tag: Buffer | null;
  bot_token_expires_at: Date | null;
  last_token_refresh_at: Date | null;
  last_token_refresh_error: string | null;
  last_token_refresh_error_at: Date | null;
  bot_user_id: string | null;
  installed_by: string | null;
  installed_at: Date | null;
  scopes: string[] | null;
  install_status: WorkspaceInstallStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelStateRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  running_summary: string;
  live_summary: string;
  live_summary_updated_at: Date | null;
  live_summary_source_ts_start: string | null;
  live_summary_source_ts_end: string | null;
  participants_json: Record<string, number>;
  active_threads_json: Array<{
    threadTs: string;
    messageCount: number;
    lastActivityAt: string;
  }>;
  key_decisions_json: string[];
  signal: "stable" | "elevated" | "escalating" | null;
  health: "healthy" | "attention" | "at-risk" | null;
  signal_confidence: number | null;
  risk_drivers_json: RiskDriver[];
  attention_summary_json: AttentionSummary | null;
  message_disposition_counts_json: MessageDispositionCounts | null;
  effective_channel_mode: ChannelMode | null;
  sentiment_snapshot_json: {
    totalMessages: number;
    highRiskCount: number;
    updatedAt: string;
    emotionDistribution?: Partial<Record<DominantEmotion, number>>;
  };
  messages_since_last_llm: number;
  last_llm_run_at: Date | null;
  llm_cooldown_until: Date | null;
  last_reconcile_at: Date | null;
  messages_since_last_rollup: number;
  last_rollup_at: Date | null;
  ingest_readiness?: IngestReadiness | null;
  intelligence_readiness?: IntelligenceReadiness | null;
  current_summary_artifact_id?: string | null;
  active_backfill_run_id?: string | null;
  active_degradation_count?: number | null;
  updated_at: Date;
}

export interface ChannelHealthCountsRow {
  channel_id: string;
  analysis_window_days: number;
  open_alert_count: string;
  high_severity_alert_count: string;
  automation_incident_count: string;
  critical_automation_incident_count: string;
  automation_incident_24h_count: string;
  critical_automation_incident_24h_count: string;
  human_risk_signal_count: string;
  request_signal_count: string;
  decision_signal_count: string;
  resolution_signal_count: string;
  flagged_message_count: string;
  high_risk_message_count: string;
  attention_thread_count: string;
  blocked_thread_count: string;
  escalated_thread_count: string;
  risky_thread_count: string;
  total_message_count: string;
  skipped_message_count: string;
  context_only_message_count: string;
  ignored_message_count: string;
  inflight_message_count: string;
  total_analyzed_count: string;
  anger_count: string;
  joy_count: string;
  sadness_count: string;
  neutral_count: string;
  fear_count: string;
  surprise_count: string;
  disgust_count: string;
}

// ─── Fathom Meeting Intelligence ─────────────────────────────────────────────

export type MeetingProcessingStatus =
  | "pending"
  | "fetching"
  | "extracting"
  | "digesting"
  | "duplicate"
  | "completed"
  | "failed";

export type MeetingExtractionStatus =
  | "not_run"
  | "pending"
  | "completed"
  | "failed";

export type MeetingObligationType =
  | "action_item"
  | "decision"
  | "commitment"
  | "question"
  | "risk"
  | "next_step";

export type MeetingObligationStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "dismissed"
  | "expired";

export type MeetingObligationPriority = "low" | "medium" | "high" | "critical";

export type MeetingObligationDueDateSource = "explicit" | "inferred" | "default";

export type FathomConnectionStatus = "active" | "revoked" | "invalid";
export type FathomHistoricalSyncStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed";
export type MeetingImportMode = "live" | "historical";
export type MeetingSource = "api" | "webhook" | "shared_link";

export type MeetingChannelLinkType = "manual" | "pattern";

export interface FathomConnectionRow {
  id: string;
  workspace_id: string;
  fathom_user_email: string | null;
  encrypted_api_key: string;
  webhook_id: string | null;
  webhook_secret: string | null;
  status: FathomConnectionStatus;
  default_channel_id: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
  historical_sync_status: FathomHistoricalSyncStatus;
  historical_sync_window_days: number;
  historical_sync_started_at: Date | null;
  historical_sync_completed_at: Date | null;
  historical_sync_discovered_count: number;
  historical_sync_imported_count: number;
  historical_sync_last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FathomParticipant {
  name: string;
  email: string | null;
  domain: string | null;
}

export interface FathomActionItem {
  text: string;
  assignee: string | null;
}

export interface MeetingRow {
  id: string;
  workspace_id: string;
  fathom_call_id: string;
  meeting_source: MeetingSource;
  channel_id: string | null;
  title: string;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  participants_json: FathomParticipant[];
  fathom_summary: string | null;
  fathom_action_items_json: FathomActionItem[];
  fathom_highlights_json: unknown[];
  recording_url: string | null;
  share_url: string | null;
  transcript_text: string | null;
  meeting_sentiment: string | null;
  risk_signals_json: Record<string, unknown>[];
  processing_status: MeetingProcessingStatus;
  extraction_status: MeetingExtractionStatus;
  digest_posted_at: Date | null;
  digest_claimed_at: Date | null;
  digest_message_ts: string | null;
  digest_thread_ts: string | null;
  digest_enabled: boolean;
  tracking_enabled: boolean;
  duplicate_of_meeting_id: string | null;
  import_mode: MeetingImportMode;
  last_error: string | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface MeetingObligationRow {
  id: string;
  workspace_id: string;
  meeting_id: string;
  channel_id: string | null;
  dedupe_key: string;
  obligation_type: MeetingObligationType;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  assignee_user_ids: string[];
  due_date: string | null;
  due_date_source: MeetingObligationDueDateSource | null;
  priority: MeetingObligationPriority;
  status: MeetingObligationStatus;
  follow_up_item_id: string | null;
  slack_evidence_json: unknown[];
  extraction_confidence: number;
  source_context: string | null;
  resolved_at: Date | null;
  resolution_evidence: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MeetingChannelLinkRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  link_type: MeetingChannelLinkType;
  domain_pattern: string | null;
  title_pattern: string | null;
  recorder_email_pattern: string | null;
  priority: number;
  enabled: boolean;
  digest_enabled: boolean;
  tracking_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// ─── Channel Classification ──────────────────────────────────────────────────

export type ChannelClassificationType =
  | "client_delivery"
  | "client_support"
  | "internal_engineering"
  | "internal_operations"
  | "internal_social"
  | "automated"
  | "unclassified";

export type ClassificationSource = "heuristic" | "llm" | "human_override";

export interface ChannelClassificationRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  channel_type: ChannelClassificationType;
  confidence: number;
  classification_source: ClassificationSource;
  client_name: string | null;
  topics_json: string[];
  reasoning: string | null;
  classified_at: Date;
  overridden_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
