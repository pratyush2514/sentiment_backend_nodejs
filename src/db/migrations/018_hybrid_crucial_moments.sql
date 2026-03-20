-- 018: Hybrid crucial-moment sentiment support

CREATE TABLE IF NOT EXISTS message_triage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    candidate_kind TEXT NOT NULL
        CHECK (candidate_kind IN (
            'ignore',
            'context_only',
            'message_candidate',
            'thread_turning_point',
            'resolution_signal'
        )),
    surface_priority TEXT NOT NULL
        CHECK (surface_priority IN ('none', 'low', 'medium', 'high')),
    candidate_score REAL NOT NULL
        CHECK (candidate_score >= 0 AND candidate_score <= 1),
    state_transition TEXT
        CHECK (state_transition IN (
            'issue_opened',
            'investigating',
            'blocked',
            'waiting_external',
            'ownership_assigned',
            'decision_made',
            'resolved',
            'escalated'
        )),
    reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    signals_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, message_ts)
);

CREATE INDEX IF NOT EXISTS idx_message_triage_candidate_kind
    ON message_triage (workspace_id, channel_id, candidate_kind);

CREATE INDEX IF NOT EXISTS idx_message_triage_surface_priority
    ON message_triage (workspace_id, channel_id, surface_priority)
    WHERE surface_priority IN ('medium', 'high');

CREATE TABLE IF NOT EXISTS thread_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    summary TEXT NOT NULL,
    primary_issue TEXT NOT NULL,
    thread_state TEXT NOT NULL
        CHECK (thread_state IN (
            'monitoring',
            'investigating',
            'blocked',
            'waiting_external',
            'resolved',
            'escalated'
        )),
    emotional_temperature TEXT NOT NULL
        CHECK (emotional_temperature IN ('calm', 'watch', 'tense', 'escalated')),
    operational_risk TEXT NOT NULL
        CHECK (operational_risk IN ('low', 'medium', 'high')),
    surface_priority TEXT NOT NULL
        CHECK (surface_priority IN ('none', 'low', 'medium', 'high')),
    crucial_moments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    open_questions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_meaningful_change_ts TEXT,
    source_ts_end TEXT,
    raw_llm_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    llm_provider TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    token_usage JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_thread_insights_surface_priority
    ON thread_insights (workspace_id, channel_id, surface_priority)
    WHERE surface_priority IN ('medium', 'high');

CREATE INDEX IF NOT EXISTS idx_thread_insights_updated_at
    ON thread_insights (workspace_id, channel_id, updated_at DESC);
