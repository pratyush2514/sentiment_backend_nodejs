-- 022: Canonical signal unification

ALTER TABLE message_triage
  ADD COLUMN IF NOT EXISTS signal_type TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT,
  ADD COLUMN IF NOT EXISTS state_impact TEXT,
  ADD COLUMN IF NOT EXISTS evidence_type TEXT,
  ADD COLUMN IF NOT EXISTS channel_mode TEXT,
  ADD COLUMN IF NOT EXISTS origin_type TEXT,
  ADD COLUMN IF NOT EXISTS confidence REAL,
  ADD COLUMN IF NOT EXISTS incident_family TEXT;

UPDATE message_triage
SET signal_type = CASE candidate_kind
    WHEN 'ignore' THEN 'ignore'
    WHEN 'context_only' THEN 'context'
    WHEN 'resolution_signal' THEN 'resolution'
    WHEN 'thread_turning_point' THEN 'human_risk'
    ELSE 'human_risk'
  END
WHERE signal_type IS NULL;

UPDATE message_triage
SET severity = CASE
    WHEN candidate_kind = 'ignore' THEN 'none'
    WHEN candidate_kind = 'context_only' THEN 'low'
    WHEN surface_priority = 'high' THEN 'high'
    WHEN surface_priority = 'medium' THEN 'medium'
    ELSE 'low'
  END
WHERE severity IS NULL;

UPDATE message_triage
SET state_impact = CASE state_transition
    WHEN 'issue_opened' THEN 'issue_opened'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'investigating' THEN 'investigating'
    WHEN 'resolved' THEN 'resolved'
    WHEN 'escalated' THEN 'escalated'
    ELSE 'none'
  END
WHERE state_impact IS NULL;

UPDATE message_triage
SET evidence_type = 'heuristic'
WHERE evidence_type IS NULL;

UPDATE message_triage
SET channel_mode = 'collaboration'
WHERE channel_mode IS NULL;

UPDATE message_triage
SET origin_type = 'human'
WHERE origin_type IS NULL;

UPDATE message_triage
SET confidence = LEAST(0.95, GREATEST(0.35, COALESCE(candidate_score, 0.5)))
WHERE confidence IS NULL;

UPDATE message_triage
SET incident_family = 'none'
WHERE incident_family IS NULL;

ALTER TABLE message_triage
  ALTER COLUMN signal_type SET NOT NULL,
  ALTER COLUMN severity SET NOT NULL,
  ALTER COLUMN state_impact SET NOT NULL,
  ALTER COLUMN evidence_type SET NOT NULL,
  ALTER COLUMN channel_mode SET NOT NULL,
  ALTER COLUMN origin_type SET NOT NULL,
  ALTER COLUMN confidence SET NOT NULL,
  ALTER COLUMN incident_family SET NOT NULL;

ALTER TABLE message_triage
  DROP CONSTRAINT IF EXISTS message_triage_signal_type_check,
  DROP CONSTRAINT IF EXISTS message_triage_severity_check,
  DROP CONSTRAINT IF EXISTS message_triage_state_impact_check,
  DROP CONSTRAINT IF EXISTS message_triage_evidence_type_check,
  DROP CONSTRAINT IF EXISTS message_triage_channel_mode_check,
  DROP CONSTRAINT IF EXISTS message_triage_origin_type_check,
  DROP CONSTRAINT IF EXISTS message_triage_incident_family_check,
  DROP CONSTRAINT IF EXISTS message_triage_confidence_check;

ALTER TABLE message_triage
  ADD CONSTRAINT message_triage_signal_type_check
    CHECK (signal_type IN (
      'ignore',
      'context',
      'request',
      'decision',
      'resolution',
      'human_risk',
      'operational_incident'
    )),
  ADD CONSTRAINT message_triage_severity_check
    CHECK (severity IN ('none', 'low', 'medium', 'high')),
  ADD CONSTRAINT message_triage_state_impact_check
    CHECK (state_impact IN (
      'none',
      'issue_opened',
      'blocked',
      'investigating',
      'resolved',
      'escalated'
    )),
  ADD CONSTRAINT message_triage_evidence_type_check
    CHECK (evidence_type IN ('heuristic', 'llm_enriched', 'rollup_derived')),
  ADD CONSTRAINT message_triage_channel_mode_check
    CHECK (channel_mode IN ('collaboration', 'automation', 'mixed')),
  ADD CONSTRAINT message_triage_origin_type_check
    CHECK (origin_type IN ('human', 'bot', 'system')),
  ADD CONSTRAINT message_triage_incident_family_check
    CHECK (incident_family IN (
      'none',
      'workflow_error',
      'execution_failure',
      'data_shape_error',
      'timeout',
      'http_error',
      'infra_error',
      'unknown'
    )),
  ADD CONSTRAINT message_triage_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1);

CREATE INDEX IF NOT EXISTS idx_message_triage_signal_type
  ON message_triage (workspace_id, channel_id, signal_type);

CREATE INDEX IF NOT EXISTS idx_message_triage_signal_severity
  ON message_triage (workspace_id, channel_id, signal_type, severity);

ALTER TABLE follow_up_rules
  ADD COLUMN IF NOT EXISTS channel_mode_override TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE follow_up_rules
  DROP CONSTRAINT IF EXISTS follow_up_rules_channel_mode_override_check;

ALTER TABLE follow_up_rules
  ADD CONSTRAINT follow_up_rules_channel_mode_override_check
    CHECK (channel_mode_override IN ('auto', 'collaboration', 'automation', 'mixed'));

ALTER TABLE channel_state
  ADD COLUMN IF NOT EXISTS signal TEXT,
  ADD COLUMN IF NOT EXISTS health TEXT,
  ADD COLUMN IF NOT EXISTS signal_confidence REAL,
  ADD COLUMN IF NOT EXISTS risk_drivers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attention_summary_json JSONB,
  ADD COLUMN IF NOT EXISTS message_disposition_counts_json JSONB,
  ADD COLUMN IF NOT EXISTS effective_channel_mode TEXT;

ALTER TABLE channel_state
  DROP CONSTRAINT IF EXISTS channel_state_signal_check,
  DROP CONSTRAINT IF EXISTS channel_state_health_check,
  DROP CONSTRAINT IF EXISTS channel_state_signal_confidence_check,
  DROP CONSTRAINT IF EXISTS channel_state_effective_channel_mode_check;

ALTER TABLE channel_state
  ADD CONSTRAINT channel_state_signal_check
    CHECK (signal IS NULL OR signal IN ('stable', 'elevated', 'escalating')),
  ADD CONSTRAINT channel_state_health_check
    CHECK (health IS NULL OR health IN ('healthy', 'attention', 'at-risk')),
  ADD CONSTRAINT channel_state_signal_confidence_check
    CHECK (signal_confidence IS NULL OR (signal_confidence >= 0 AND signal_confidence <= 1)),
  ADD CONSTRAINT channel_state_effective_channel_mode_check
    CHECK (effective_channel_mode IS NULL OR effective_channel_mode IN ('collaboration', 'automation', 'mixed'));
