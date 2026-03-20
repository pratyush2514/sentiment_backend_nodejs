-- Add install_status to workspaces for lifecycle tracking (active / uninstalled)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS install_status TEXT NOT NULL DEFAULT 'active';
