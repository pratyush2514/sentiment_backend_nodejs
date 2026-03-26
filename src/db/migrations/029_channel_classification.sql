-- 029_channel_classification.sql
-- AI-powered channel classification: semantic understanding of what each channel is for.
-- Foundation for intelligent alert routing, SLA configuration, and analytics segmentation.

CREATE TABLE IF NOT EXISTS channel_classifications (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    channel_type            TEXT NOT NULL DEFAULT 'unclassified'
                            CHECK (channel_type IN (
                                'client_delivery',
                                'client_support',
                                'internal_engineering',
                                'internal_operations',
                                'internal_social',
                                'automated',
                                'unclassified'
                            )),
    confidence              REAL NOT NULL DEFAULT 0
                            CHECK (confidence >= 0 AND confidence <= 1),
    classification_source   TEXT NOT NULL DEFAULT 'heuristic'
                            CHECK (classification_source IN ('heuristic', 'llm', 'human_override')),
    client_name             TEXT,
    topics_json             JSONB NOT NULL DEFAULT '[]'::jsonb,
    reasoning               TEXT,
    classified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overridden_at           TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_classifications_type
    ON channel_classifications (workspace_id, channel_type);

CREATE INDEX IF NOT EXISTS idx_channel_classifications_needs_llm
    ON channel_classifications (workspace_id, confidence)
    WHERE classification_source != 'human_override' AND confidence < 0.7;

-- Separate LLM budget pool tracking: add budget_pool to llm_costs if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'llm_costs') THEN
        ALTER TABLE llm_costs ADD COLUMN IF NOT EXISTS budget_pool TEXT NOT NULL DEFAULT 'realtime'
            CHECK (budget_pool IN ('realtime', 'infrastructure'));
    END IF;
END $$;
