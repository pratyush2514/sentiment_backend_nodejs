-- Harden the Fathom meeting pipeline for retry safety, digest recovery, and
-- explicit meeting-level tracking controls.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS meeting_sentiment TEXT,
    ADD COLUMN IF NOT EXISTS risk_signals_json JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS digest_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS duplicate_of_meeting_id UUID REFERENCES meetings(id) ON DELETE SET NULL;

ALTER TABLE meeting_obligations
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

WITH obligation_keys AS (
    SELECT
        id,
        meeting_id,
        encode(digest(
            lower(trim(obligation_type)) || '|' ||
            lower(trim(title)) || '|' ||
            lower(trim(COALESCE(owner_name, ''))) || '|' ||
            COALESCE(due_date::TEXT, ''),
            'sha256'
        ), 'hex') AS base_key
    FROM meeting_obligations
),
ranked_keys AS (
    SELECT
        id,
        base_key,
        ROW_NUMBER() OVER (
            PARTITION BY obligation_keys.meeting_id, base_key
            ORDER BY meeting_obligations.created_at ASC, id ASC
        ) AS duplicate_rank
    FROM obligation_keys
    JOIN meeting_obligations USING (id)
)
UPDATE meeting_obligations mo
SET dedupe_key = CASE
    WHEN ranked_keys.duplicate_rank = 1 THEN ranked_keys.base_key
    ELSE ranked_keys.base_key || ':' || mo.id::TEXT
END
FROM ranked_keys
WHERE mo.id = ranked_keys.id
  AND mo.dedupe_key IS NULL;

ALTER TABLE meeting_obligations
    ALTER COLUMN dedupe_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_obligations_meeting_dedupe
    ON meeting_obligations (meeting_id, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_share_url
    ON meetings (workspace_id, share_url)
    WHERE share_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_workspace_recording_url
    ON meetings (workspace_id, recording_url)
    WHERE recording_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_digest_claimed
    ON meetings (workspace_id, digest_claimed_at)
    WHERE digest_claimed_at IS NOT NULL;
