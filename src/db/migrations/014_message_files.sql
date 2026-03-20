-- 014: Add files_json column to messages table
-- Stores Slack file attachment metadata (name, title, mimetype, filetype, size, permalink)
-- as JSONB array. No binary content — just metadata for display and LLM context.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS files_json JSONB DEFAULT NULL;
