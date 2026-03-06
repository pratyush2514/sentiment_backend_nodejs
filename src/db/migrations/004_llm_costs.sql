-- Migration 004: LLM cost tracking
-- Tracks per-request LLM costs for budget enforcement and observability

CREATE TABLE llm_costs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT,
    llm_provider        TEXT NOT NULL,
    llm_model           TEXT NOT NULL,
    prompt_tokens       INTEGER NOT NULL,
    completion_tokens   INTEGER NOT NULL,
    estimated_cost_usd  DECIMAL(10,6) NOT NULL,
    job_type            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_costs_workspace_time ON llm_costs (workspace_id, created_at);
