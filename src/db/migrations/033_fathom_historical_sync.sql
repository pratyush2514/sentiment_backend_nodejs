-- Track historical Fathom import status and mark meetings imported from history
-- so downstream side effects can be suppressed deterministically.

ALTER TABLE fathom_connections
    ADD COLUMN IF NOT EXISTS historical_sync_status TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS historical_sync_window_days INTEGER NOT NULL DEFAULT 14,
    ADD COLUMN IF NOT EXISTS historical_sync_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS historical_sync_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS historical_sync_discovered_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS historical_sync_imported_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS historical_sync_last_error TEXT;

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS import_mode TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_fathom_connections_historical_sync_status
    ON fathom_connections (historical_sync_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_import_mode
    ON meetings (workspace_id, import_mode, started_at DESC);
