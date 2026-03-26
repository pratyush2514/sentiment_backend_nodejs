ALTER TABLE channel_state
    ADD COLUMN IF NOT EXISTS live_summary TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS live_summary_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS live_summary_source_ts_start TEXT,
    ADD COLUMN IF NOT EXISTS live_summary_source_ts_end TEXT;

CREATE INDEX IF NOT EXISTS idx_channel_state_live_summary_updated_at
    ON channel_state (workspace_id, live_summary_updated_at DESC);
