-- Tiered backfill: allow channels to be "ready" before full 30-day history is imported.
-- Tier 1 (instant): metadata + members → ready with "bootstrap" intelligence
-- Tier 2 (fast): last 24h messages + quick summary → "partial" intelligence
-- Tier 3 (background): full 30-day history + deep analysis → "ready" intelligence

-- Add "bootstrap" to intelligence_readiness allowed values
ALTER TABLE channel_state
  DROP CONSTRAINT IF EXISTS channel_state_intelligence_readiness_check;

DO $$ BEGIN
  ALTER TABLE channel_state
    ADD CONSTRAINT channel_state_intelligence_readiness_check
    CHECK (intelligence_readiness IN ('missing', 'bootstrap', 'partial', 'ready', 'stale'));
EXCEPTION WHEN others THEN NULL;
END $$;

-- Track which backfill tier is currently active (NULL = done, 1/2/3 = in progress)
ALTER TABLE channel_state
  ADD COLUMN IF NOT EXISTS backfill_tier SMALLINT DEFAULT NULL;

-- Track where Tier 2 stopped so Tier 3 knows its boundary
ALTER TABLE channel_state
  ADD COLUMN IF NOT EXISTS tier2_coverage_oldest_ts TEXT DEFAULT NULL;
