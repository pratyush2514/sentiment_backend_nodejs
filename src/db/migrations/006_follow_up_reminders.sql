CREATE TABLE IF NOT EXISTS follow_up_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    sla_hours           INTEGER NOT NULL DEFAULT 48 CHECK (sla_hours > 0),
    owner_user_ids      JSONB NOT NULL DEFAULT '[]',
    client_user_ids     JSONB NOT NULL DEFAULT '[]',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_follow_up_rules_workspace
    ON follow_up_rules (workspace_id, channel_id);

CREATE TABLE IF NOT EXISTS follow_up_items (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    source_message_ts       TEXT NOT NULL,
    source_thread_ts        TEXT,
    requester_user_id       TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'resolved', 'dismissed')),
    seriousness             TEXT NOT NULL DEFAULT 'medium'
                            CHECK (seriousness IN ('low', 'medium', 'high')),
    seriousness_score       INTEGER NOT NULL DEFAULT 0,
    detection_mode          TEXT NOT NULL DEFAULT 'heuristic'
                            CHECK (detection_mode IN ('heuristic', 'rule', 'hybrid', 'llm')),
    reason_codes            JSONB NOT NULL DEFAULT '[]',
    summary                 TEXT NOT NULL DEFAULT '',
    due_at                  TIMESTAMPTZ NOT NULL,
    last_alerted_at         TIMESTAMPTZ,
    alert_count             INTEGER NOT NULL DEFAULT 0,
    last_request_ts         TEXT,
    repeated_ask_count      INTEGER NOT NULL DEFAULT 1,
    resolved_at             TIMESTAMPTZ,
    resolved_message_ts     TEXT,
    dismissed_at            TIMESTAMPTZ,
    metadata_json           JSONB NOT NULL DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, source_message_ts)
);

CREATE INDEX IF NOT EXISTS idx_follow_up_items_status_due
    ON follow_up_items (workspace_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_items_channel_status
    ON follow_up_items (workspace_id, channel_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_follow_up_items_requester
    ON follow_up_items (workspace_id, requester_user_id, status);
