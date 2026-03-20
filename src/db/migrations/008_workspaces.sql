-- Migration 008: Workspace bot token storage for multi-tenant OAuth
-- Stores encrypted bot tokens per Slack workspace (team_id)

CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id        TEXT PRIMARY KEY,
    team_name           TEXT,
    bot_token_encrypted BYTEA NOT NULL,
    bot_token_iv        BYTEA NOT NULL,
    bot_token_tag       BYTEA NOT NULL,
    bot_user_id         TEXT,
    installed_by        TEXT,
    installed_at        TIMESTAMPTZ DEFAULT NOW(),
    scopes              TEXT[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
