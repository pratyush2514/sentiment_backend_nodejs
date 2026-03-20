ALTER TABLE follow_up_items
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT
    CHECK (resolution_reason IN (
      'reply',
      'reaction_ack',
      'requester_ack',
      'natural_conclusion',
      'manual_done',
      'manual_dismissed',
      'expired'
    )),
  ADD COLUMN IF NOT EXISTS resolution_scope TEXT
    CHECK (resolution_scope IN ('thread', 'channel', 'reaction', 'manual', 'system')),
  ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS last_engagement_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_follow_up_items_resolution_reason
  ON follow_up_items (workspace_id, resolution_reason, resolved_at DESC);
