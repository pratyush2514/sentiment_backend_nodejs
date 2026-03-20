-- 010: Channel members table + display label on role assignments
--
-- Stores the full member list fetched from Slack's conversations.members API,
-- so participants who haven't sent messages are still visible in the UI.

CREATE TABLE IF NOT EXISTS channel_members (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_channel
    ON channel_members (workspace_id, channel_id);

-- Display label allows users to assign human titles like "Founder", "Junior Dev"
-- alongside the operational role (client/worker/senior/observer).
ALTER TABLE role_assignments
    ADD COLUMN IF NOT EXISTS display_label TEXT;
