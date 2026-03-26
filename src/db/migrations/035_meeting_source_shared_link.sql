ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS meeting_source TEXT NOT NULL DEFAULT 'api';

ALTER TABLE meetings
  DROP CONSTRAINT IF EXISTS meetings_meeting_source_check;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_meeting_source_check
    CHECK (meeting_source IN ('api', 'webhook', 'shared_link'));
