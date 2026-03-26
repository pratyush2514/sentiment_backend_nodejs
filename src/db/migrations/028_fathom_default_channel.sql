-- Add default/fallback channel for unmatched meetings
ALTER TABLE fathom_connections ADD COLUMN IF NOT EXISTS default_channel_id TEXT;
