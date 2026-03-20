ALTER TABLE slack_events
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'processed'
    CHECK (processing_status IN ('processing', 'processed', 'failed'));

ALTER TABLE slack_events
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE slack_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE slack_events
SET processing_status = 'processed',
    updated_at = COALESCE(updated_at, received_at)
WHERE processing_status IS DISTINCT FROM 'processed'
   OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_slack_events_processing_status
  ON slack_events (processing_status, received_at);
