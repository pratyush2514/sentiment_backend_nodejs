-- 026_fathom_meeting_intelligence.sql
-- Adds tables for Fathom meeting integration: connections, meetings, obligations, channel links

-- Fathom API connection per workspace
CREATE TABLE IF NOT EXISTS fathom_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    fathom_user_email   TEXT,
    encrypted_api_key   TEXT NOT NULL,
    webhook_id          TEXT,
    webhook_secret      TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    last_synced_at      TIMESTAMPTZ,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id)
);

-- One row per Fathom meeting recording
CREATE TABLE IF NOT EXISTS meetings (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id                TEXT NOT NULL,
    fathom_call_id              TEXT NOT NULL,
    channel_id                  TEXT,
    title                       TEXT NOT NULL,
    started_at                  TIMESTAMPTZ NOT NULL,
    ended_at                    TIMESTAMPTZ,
    duration_seconds            INTEGER,
    participants_json           JSONB NOT NULL DEFAULT '[]',
    fathom_summary              TEXT,
    fathom_action_items_json    JSONB NOT NULL DEFAULT '[]',
    fathom_highlights_json      JSONB NOT NULL DEFAULT '[]',
    recording_url               TEXT,
    share_url                   TEXT,
    transcript_text             TEXT,
    processing_status           TEXT NOT NULL DEFAULT 'pending',
    extraction_status           TEXT NOT NULL DEFAULT 'not_run',
    digest_posted_at            TIMESTAMPTZ,
    digest_message_ts           TEXT,
    digest_thread_ts            TEXT,
    last_error                  TEXT,
    attempt_count               INTEGER NOT NULL DEFAULT 0,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, fathom_call_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_channel
    ON meetings (workspace_id, channel_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_meetings_processing
    ON meetings (workspace_id, processing_status, updated_at DESC);

-- Extracted obligations from meetings (action items, decisions, commitments, etc.)
CREATE TABLE IF NOT EXISTS meeting_obligations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            TEXT NOT NULL,
    meeting_id              UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    channel_id              TEXT,
    obligation_type         TEXT NOT NULL,
    title                   TEXT NOT NULL,
    description             TEXT,
    owner_user_id           TEXT,
    owner_name              TEXT,
    assignee_user_ids       JSONB NOT NULL DEFAULT '[]',
    due_date                DATE,
    due_date_source         TEXT,
    priority                TEXT NOT NULL DEFAULT 'medium',
    status                  TEXT NOT NULL DEFAULT 'open',
    follow_up_item_id       UUID,
    slack_evidence_json     JSONB NOT NULL DEFAULT '[]',
    extraction_confidence   REAL NOT NULL DEFAULT 0.0,
    source_context          TEXT,
    resolved_at             TIMESTAMPTZ,
    resolution_evidence     TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_obligations_workspace_status
    ON meeting_obligations (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_meeting_obligations_meeting
    ON meeting_obligations (meeting_id);

CREATE INDEX IF NOT EXISTS idx_meeting_obligations_channel
    ON meeting_obligations (workspace_id, channel_id, status);

CREATE INDEX IF NOT EXISTS idx_meeting_obligations_owner
    ON meeting_obligations (workspace_id, owner_user_id, status);

CREATE INDEX IF NOT EXISTS idx_meeting_obligations_follow_up
    ON meeting_obligations (follow_up_item_id)
    WHERE follow_up_item_id IS NOT NULL;

-- Channel-to-meeting mapping rules
CREATE TABLE IF NOT EXISTS meeting_channel_links (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    link_type               TEXT NOT NULL DEFAULT 'manual',
    domain_pattern          TEXT,
    title_pattern           TEXT,
    recorder_email_pattern  TEXT,
    priority                INTEGER NOT NULL DEFAULT 0,
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    digest_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    tracking_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_channel_links_workspace
    ON meeting_channel_links (workspace_id, enabled, priority DESC);

-- Add meeting_obligation_id to follow_up_items for back-linking
ALTER TABLE follow_up_items
    ADD COLUMN IF NOT EXISTS meeting_obligation_id UUID;

-- Add recording URLs (may already exist if migration ran fresh)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS share_url TEXT;
