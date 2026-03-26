-- 025: Intelligence truthfulness foundation

CREATE TABLE IF NOT EXISTS message_intelligence_state (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    message_ts          TEXT NOT NULL,
    eligibility_status  TEXT NOT NULL DEFAULT 'eligible'
                        CHECK (eligibility_status IN (
                            'eligible',
                            'not_candidate',
                            'policy_suppressed',
                            'privacy_suppressed'
                        )),
    execution_status    TEXT NOT NULL DEFAULT 'not_run'
                        CHECK (execution_status IN (
                            'not_run',
                            'pending',
                            'processing',
                            'completed',
                            'failed'
                        )),
    quality_status      TEXT NOT NULL DEFAULT 'none'
                        CHECK (quality_status IN (
                            'none',
                            'fallback',
                            'partial',
                            'verified'
                        )),
    suppression_reason  TEXT
                        CHECK (suppression_reason IS NULL OR suppression_reason IN (
                            'channel_not_ready',
                            'cooldown',
                            'importance_tier',
                            'privacy_skip',
                            'budget_exceeded',
                            'not_candidate'
                        )),
    provider_name       TEXT,
    provider_model      TEXT,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    recovered_at        TIMESTAMPTZ,
    last_error          TEXT,
    last_error_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, message_ts)
);

CREATE INDEX IF NOT EXISTS idx_message_intelligence_state_channel_status
    ON message_intelligence_state (workspace_id, channel_id, execution_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS summary_artifacts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    summary_kind            TEXT NOT NULL
                            CHECK (summary_kind IN (
                                'channel_rollup',
                                'thread_rollup',
                                'backfill_rollup'
                            )),
    generation_mode         TEXT NOT NULL
                            CHECK (generation_mode IN (
                                'llm',
                                'fallback',
                                'reused_existing'
                            )),
    completeness_status     TEXT NOT NULL DEFAULT 'complete'
                            CHECK (completeness_status IN (
                                'complete',
                                'partial',
                                'stale',
                                'no_recent_messages'
                            )),
    summary                 TEXT NOT NULL,
    key_decisions_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    degraded_reasons_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
    coverage_start_ts       TEXT,
    coverage_end_ts         TEXT,
    candidate_message_count INTEGER NOT NULL DEFAULT 0,
    included_message_count  INTEGER NOT NULL DEFAULT 0,
    artifact_version        INTEGER NOT NULL DEFAULT 1,
    source_run_id           UUID,
    superseded_at           TIMESTAMPTZ,
    superseded_by_artifact_id UUID,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summary_artifacts_channel_kind_created
    ON summary_artifacts (workspace_id, channel_id, summary_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_summary_artifacts_source_run
    ON summary_artifacts (source_run_id);

CREATE TABLE IF NOT EXISTS backfill_runs (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          TEXT NOT NULL,
    channel_id            TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN (
                              'running',
                              'completed',
                              'completed_with_degradations',
                              'failed'
                          )),
    current_phase         TEXT NOT NULL DEFAULT 'history_import'
                          CHECK (current_phase IN (
                              'history_import',
                              'thread_expansion',
                              'user_enrichment',
                              'member_sync',
                              'initial_intelligence',
                              'finalize'
                          )),
    pages_fetched         INTEGER NOT NULL DEFAULT 0,
    messages_imported     INTEGER NOT NULL DEFAULT 0,
    thread_roots_discovered INTEGER NOT NULL DEFAULT 0,
    threads_attempted     INTEGER NOT NULL DEFAULT 0,
    threads_failed        INTEGER NOT NULL DEFAULT 0,
    users_resolved        INTEGER NOT NULL DEFAULT 0,
    member_sync_result    TEXT NOT NULL DEFAULT 'not_started'
                          CHECK (member_sync_result IN (
                              'not_started',
                              'running',
                              'succeeded',
                              'degraded',
                              'failed'
                          )),
    summary_artifact_id   UUID,
    degraded_reason_count INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at          TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_runs_channel_status
    ON backfill_runs (workspace_id, channel_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_backfill_runs_running
    ON backfill_runs (workspace_id, channel_id, updated_at DESC)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS intelligence_degradation_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    scope_type          TEXT NOT NULL
                        CHECK (scope_type IN (
                            'channel',
                            'message',
                            'thread',
                            'summary_artifact',
                            'backfill_run'
                        )),
    scope_key           TEXT,
    message_ts          TEXT,
    thread_ts           TEXT,
    summary_artifact_id UUID,
    backfill_run_id     UUID,
    degradation_type    TEXT NOT NULL
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
                            'meta_summary_fallback'
                        )),
    severity            TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info', 'warning', 'error')),
    details_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key          TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    superseded_by_event_id UUID,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_degradation_active
    ON intelligence_degradation_events (workspace_id, channel_id, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_degradation_scope
    ON intelligence_degradation_events (workspace_id, channel_id, scope_type, scope_key);

ALTER TABLE channel_state
    ADD COLUMN IF NOT EXISTS ingest_readiness TEXT NOT NULL DEFAULT 'not_started'
        CHECK (ingest_readiness IN ('not_started', 'hydrating', 'ready')),
    ADD COLUMN IF NOT EXISTS intelligence_readiness TEXT NOT NULL DEFAULT 'missing'
        CHECK (intelligence_readiness IN ('missing', 'partial', 'ready', 'stale')),
    ADD COLUMN IF NOT EXISTS current_summary_artifact_id UUID,
    ADD COLUMN IF NOT EXISTS active_backfill_run_id UUID,
    ADD COLUMN IF NOT EXISTS active_degradation_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE context_documents
    ADD COLUMN IF NOT EXISTS summary_artifact_id UUID;

CREATE INDEX IF NOT EXISTS idx_context_documents_summary_artifact
    ON context_documents (workspace_id, channel_id, summary_artifact_id);
