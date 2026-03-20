ALTER TABLE IF EXISTS thread_insights
  DROP CONSTRAINT IF EXISTS thread_insights_operational_risk_check;

ALTER TABLE IF EXISTS thread_insights
  ADD CONSTRAINT thread_insights_operational_risk_check
  CHECK (operational_risk IN ('none', 'low', 'medium', 'high'));
