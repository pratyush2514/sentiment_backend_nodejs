-- Track the last DM sent for each follow-up item so we can:
-- 1. Delete the previous DM before sending a new one (no spam)
-- 2. Survive backend restarts (in-memory timers are lost)
-- Uses JSONB array to track per-user DM info.

ALTER TABLE follow_up_items
  ADD COLUMN IF NOT EXISTS last_dm_refs JSONB NOT NULL DEFAULT '[]';

-- last_dm_refs schema: [{ "userId": "U...", "dmChannelId": "D...", "messageTs": "17..." }, ...]
