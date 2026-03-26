-- 036: Persist evidence-backed summary facts alongside summary artifacts

ALTER TABLE summary_artifacts
    ADD COLUMN IF NOT EXISTS summary_facts_json JSONB NOT NULL DEFAULT '[]'::jsonb;
