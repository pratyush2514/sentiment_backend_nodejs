-- Migration 003: Context documents with vector embeddings (Phase D)
-- Requires pgvector extension enabled on Supabase instance

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS context_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    doc_type            TEXT NOT NULL
                        CHECK (doc_type IN ('channel_rollup', 'thread_rollup', 'backfill_rollup')),
    content             TEXT NOT NULL,
    token_count         INTEGER NOT NULL,
    embedding           vector(1536),
    source_ts_start     TEXT,
    source_ts_end       TEXT,
    source_thread_ts    TEXT,
    message_count       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index for channel-scoped queries (used before vector search)
CREATE INDEX IF NOT EXISTS idx_context_docs_channel
    ON context_documents (workspace_id, channel_id, doc_type);

-- IVFFlat index for cosine similarity search
CREATE INDEX IF NOT EXISTS idx_context_docs_embedding
    ON context_documents USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Add rollup tracking columns to channel_state
ALTER TABLE channel_state
    ADD COLUMN IF NOT EXISTS messages_since_last_rollup INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_rollup_at TIMESTAMPTZ;
