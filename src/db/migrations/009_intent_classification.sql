-- 009: Add intent classification columns to message_analytics
-- These columns store the LLM-classified organizational intent of each message,
-- enabling role-aware priority routing and context-aware SLA computation.

ALTER TABLE message_analytics
  ADD COLUMN IF NOT EXISTS message_intent TEXT
    CHECK (message_intent IN ('request','question','decision','commitment','blocker','escalation','fyi','acknowledgment')),
  ADD COLUMN IF NOT EXISTS is_actionable BOOLEAN,
  ADD COLUMN IF NOT EXISTS is_blocking BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS urgency_level TEXT DEFAULT 'none'
    CHECK (urgency_level IN ('none','low','medium','high','critical'));

CREATE INDEX IF NOT EXISTS idx_analytics_intent
  ON message_analytics (message_intent)
  WHERE message_intent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_actionable
  ON message_analytics (is_actionable)
  WHERE is_actionable = TRUE;
