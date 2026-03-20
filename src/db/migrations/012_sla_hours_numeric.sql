-- Allow fractional SLA hours (e.g. 0.5 = 30 minutes)
ALTER TABLE follow_up_rules
  ALTER COLUMN sla_hours TYPE NUMERIC(10,4) USING sla_hours::NUMERIC(10,4);

ALTER TABLE follow_up_rules
  DROP CONSTRAINT IF EXISTS follow_up_rules_sla_hours_check;

ALTER TABLE follow_up_rules
  ADD CONSTRAINT follow_up_rules_sla_hours_check CHECK (sla_hours > 0);
