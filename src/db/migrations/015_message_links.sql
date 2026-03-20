-- 015: Add links_json column to messages table
-- Stores extracted link metadata (url, domain, label, linkType) as JSONB array.
-- Enables type-aware link rendering in frontend and richer LLM context.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS links_json JSONB DEFAULT NULL;
