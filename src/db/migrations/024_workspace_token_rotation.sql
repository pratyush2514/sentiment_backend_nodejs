-- Add Slack bot token rotation lifecycle fields to workspaces.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bot_refresh_token_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS bot_refresh_token_iv BYTEA,
  ADD COLUMN IF NOT EXISTS bot_refresh_token_tag BYTEA,
  ADD COLUMN IF NOT EXISTS bot_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_token_refresh_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_token_refresh_error TEXT,
  ADD COLUMN IF NOT EXISTS last_token_refresh_error_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_workspaces_token_refresh_due
  ON workspaces (bot_token_expires_at)
  WHERE install_status = 'active'
    AND bot_refresh_token_encrypted IS NOT NULL;
