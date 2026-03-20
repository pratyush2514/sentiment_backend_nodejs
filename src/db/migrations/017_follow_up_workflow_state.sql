ALTER TABLE follow_up_items
  ADD COLUMN IF NOT EXISTS workflow_state TEXT
    CHECK (
      workflow_state IN (
        'pending_reply_window',
        'awaiting_primary',
        'acknowledged_waiting',
        'escalated',
        'resolved',
        'dismissed',
        'expired'
      )
    ),
  ADD COLUMN IF NOT EXISTS primary_responder_ids JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS escalation_responder_ids JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS acknowledgment_source TEXT
    CHECK (acknowledgment_source IN ('message', 'reaction', 'manual', 'system')),
  ADD COLUMN IF NOT EXISTS engaged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ignored_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resolved_via_escalation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS primary_missed_sla BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visibility_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_responder_user_id TEXT,
  ADD COLUMN IF NOT EXISTS last_responder_message_ts TEXT,
  ADD COLUMN IF NOT EXISTS next_expected_response_at TIMESTAMPTZ;

UPDATE follow_up_items
SET workflow_state = CASE
    WHEN status = 'resolved' AND resolution_reason = 'expired' THEN 'expired'
    WHEN status = 'resolved' THEN 'resolved'
    WHEN status = 'dismissed' THEN 'dismissed'
    ELSE 'awaiting_primary'
  END
WHERE workflow_state IS NULL;

UPDATE follow_up_items
SET visibility_after = COALESCE(visibility_after, created_at)
WHERE visibility_after IS NULL;

UPDATE follow_up_items
SET primary_responder_ids = CASE
    WHEN jsonb_typeof(metadata_json -> 'expectedResponderIds') = 'array'
      THEN metadata_json -> 'expectedResponderIds'
    ELSE '[]'::jsonb
  END
WHERE primary_responder_ids = '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_follow_up_items_workflow_visible
  ON follow_up_items (workspace_id, workflow_state, visibility_after, due_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_items_primary_responder_ids
  ON follow_up_items USING GIN (primary_responder_ids);

CREATE INDEX IF NOT EXISTS idx_follow_up_items_escalation_responder_ids
  ON follow_up_items USING GIN (escalation_responder_ids);

CREATE TABLE IF NOT EXISTS follow_up_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follow_up_item_id UUID NOT NULL REFERENCES follow_up_items(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'created',
        'acknowledged',
        'escalated',
        'resolved',
        'reopened',
        'snoozed',
        'dismissed',
        'expired'
      )
    ),
  workflow_state TEXT,
  actor_user_id TEXT,
  message_ts TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_up_events_item_created
  ON follow_up_events (follow_up_item_id, created_at DESC);
