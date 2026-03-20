-- Migration 019: add message interaction tone for safer workplace surfacing

ALTER TABLE message_analytics
  ADD COLUMN IF NOT EXISTS interaction_tone TEXT
  CHECK (interaction_tone IN (
    'neutral',
    'collaborative',
    'corrective',
    'tense',
    'confrontational',
    'dismissive'
  ));

CREATE INDEX IF NOT EXISTS idx_message_analytics_interaction_tone
  ON message_analytics (workspace_id, channel_id, interaction_tone);
