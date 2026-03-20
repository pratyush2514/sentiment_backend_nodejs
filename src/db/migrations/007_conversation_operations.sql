ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS conversation_type TEXT NOT NULL DEFAULT 'public_channel'
        CHECK (conversation_type IN ('public_channel', 'private_channel', 'dm', 'group_dm'));

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE follow_up_rules
    ADD COLUMN IF NOT EXISTS senior_user_ids JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS slack_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS privacy_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS conversation_type TEXT NOT NULL DEFAULT 'public_channel'
        CHECK (conversation_type IN ('public_channel', 'private_channel', 'dm', 'group_dm'));

ALTER TABLE follow_up_items
    ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS role_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL
                    CHECK (role IN ('client', 'worker', 'senior', 'observer')),
    source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'inferred')),
    review_state    TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (review_state IN ('suggested', 'confirmed', 'rejected')),
    confidence      NUMERIC(5,4) NOT NULL DEFAULT 1.0,
    reasons_json    JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_workspace_user
    ON role_assignments (workspace_id, user_id, review_state);
