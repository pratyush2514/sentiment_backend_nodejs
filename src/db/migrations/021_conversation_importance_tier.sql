ALTER TABLE follow_up_rules
  ADD COLUMN IF NOT EXISTS importance_tier_override TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE follow_up_rules
  DROP CONSTRAINT IF EXISTS follow_up_rules_importance_tier_override_check;

ALTER TABLE follow_up_rules
  ADD CONSTRAINT follow_up_rules_importance_tier_override_check
  CHECK (importance_tier_override IN ('auto', 'high_value', 'standard', 'low_value'));
