ALTER TABLE follow_up_rules
  ADD COLUMN IF NOT EXISTS analysis_window_days INTEGER NOT NULL DEFAULT 7;

ALTER TABLE follow_up_rules
  DROP CONSTRAINT IF EXISTS follow_up_rules_analysis_window_days_check;

ALTER TABLE follow_up_rules
  ADD CONSTRAINT follow_up_rules_analysis_window_days_check
  CHECK (analysis_window_days BETWEEN 1 AND 30);
