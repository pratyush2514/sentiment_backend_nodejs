-- Migration 001: Foundation tables
-- Run against Supabase PostgreSQL (direct connection)

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Channel registry
CREATE TABLE IF NOT EXISTS channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    name            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','initializing','ready','failed')),
    initialized_at  TIMESTAMPTZ,
    last_event_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id)
);

-- Event deduplication (replaces in-memory Set)
CREATE TABLE IF NOT EXISTS slack_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_events_received
    ON slack_events (received_at);

-- Raw message storage
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    ts              TEXT NOT NULL,
    thread_ts       TEXT,
    user_id         TEXT NOT NULL,
    text            TEXT NOT NULL,
    normalized_text TEXT,
    subtype         TEXT,
    bot_id          TEXT,
    source          TEXT NOT NULL DEFAULT 'realtime'
                    CHECK (source IN ('realtime','backfill')),
    analysis_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (analysis_status IN (
                        'pending','processing','completed','failed','skipped'
                    )),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_time
    ON messages (workspace_id, channel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages (workspace_id, channel_id, thread_ts)
    WHERE thread_ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_analysis_pending
    ON messages (analysis_status)
    WHERE analysis_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_messages_user
    ON messages (workspace_id, user_id);

-- Thread structure graph
CREATE TABLE IF NOT EXISTS thread_edges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    thread_ts       TEXT NOT NULL,
    child_ts        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, thread_ts, child_ts)
);

CREATE INDEX IF NOT EXISTS idx_thread_edges_root
    ON thread_edges (workspace_id, channel_id, thread_ts);

-- User profile cache
CREATE TABLE IF NOT EXISTS user_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    display_name    TEXT,
    real_name       TEXT,
    profile_image   TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, user_id)
);

-- Per-channel derived state
CREATE TABLE IF NOT EXISTS channel_state (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id                TEXT NOT NULL,
    channel_id                  TEXT NOT NULL,
    running_summary             TEXT NOT NULL DEFAULT '',
    participants_json           JSONB DEFAULT '{}',
    active_threads_json         JSONB DEFAULT '[]',
    key_decisions_json          JSONB DEFAULT '[]',
    sentiment_snapshot_json     JSONB DEFAULT '{}',
    messages_since_last_llm     INTEGER NOT NULL DEFAULT 0,
    last_llm_run_at             TIMESTAMPTZ,
    llm_cooldown_until          TIMESTAMPTZ,
    last_reconcile_at           TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id)
);
