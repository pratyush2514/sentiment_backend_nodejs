-- Fix: ensure recording_url and share_url columns exist on meetings table.
-- Migration 026 included these in CREATE TABLE but if the table already existed
-- from a partial run, the columns may be missing.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS share_url TEXT;
