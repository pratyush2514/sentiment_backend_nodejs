-- 034: Allow meeting-scoped intelligence degradations and Fathom degradation types

ALTER TABLE intelligence_degradation_events
  DROP CONSTRAINT IF EXISTS intelligence_degradation_events_scope_type_check;

ALTER TABLE intelligence_degradation_events
  ADD CONSTRAINT intelligence_degradation_events_scope_type_check
  CHECK (scope_type IN (
    'channel',
    'message',
    'thread',
    'summary_artifact',
    'backfill_run',
    'meeting'
  ));

ALTER TABLE intelligence_degradation_events
  DROP CONSTRAINT IF EXISTS intelligence_degradation_events_degradation_type_check;

ALTER TABLE intelligence_degradation_events
  ADD CONSTRAINT intelligence_degradation_events_degradation_type_check
  CHECK (degradation_type IN (
    'embedding_failure',
    'thread_fetch_skipped',
    'metadata_resolution_failure',
    'thread_insight_enqueue_failure',
    'budget_truncation',
    'budget_truncated',
    'provider_validation_retry_exhaustion',
    'unresolved_target_users',
    'partial_thread_fetch',
    'incomplete_persisted_analysis',
    'budget_exceeded',
    'embedding_failed',
    'thread_fetch_failed',
    'member_sync_failed',
    'analysis_failed',
    'analysis_threw_unexpected_error',
    'incomplete_persisted_analysis_recovered',
    'low_signal_channel',
    'meta_summary_fallback',
    'fathom_fetch_failed',
    'fathom_extraction_failed',
    'fathom_digest_failed',
    'fathom_channel_link_missing',
    'meeting_participant_resolution_failed'
  ));
