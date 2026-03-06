-- Migration 005: Data retention policies
-- Requires pg_cron extension (available on Supabase pro plans)
-- Falls back gracefully if pg_cron is not available

-- ─── Retention functions ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION retention_delete_old_messages(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM messages
  WHERE created_at < NOW() - MAKE_INTERVAL(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retention_delete_old_analytics(retention_days INTEGER DEFAULT 180)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM message_analytics
  WHERE created_at < NOW() - MAKE_INTERVAL(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retention_delete_old_events(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM slack_events
  WHERE received_at < NOW() - MAKE_INTERVAL(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retention_delete_old_context_documents(retention_days INTEGER DEFAULT 180)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM context_documents
  WHERE created_at < NOW() - MAKE_INTERVAL(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION retention_delete_old_llm_costs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM llm_costs
  WHERE created_at < NOW() - MAKE_INTERVAL(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ─── pg_cron schedules (3 AM UTC daily, staggered by 5 min) ─────────────
-- These will only be created if pg_cron extension is installed.
-- On Supabase, enable via Dashboard > Database > Extensions > pg_cron

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'retention-messages',
      '0 3 * * *',
      'SELECT retention_delete_old_messages(90)'
    );
    PERFORM cron.schedule(
      'retention-analytics',
      '5 3 * * *',
      'SELECT retention_delete_old_analytics(180)'
    );
    PERFORM cron.schedule(
      'retention-events',
      '10 3 * * *',
      'SELECT retention_delete_old_events(30)'
    );
    PERFORM cron.schedule(
      'retention-context-docs',
      '15 3 * * *',
      'SELECT retention_delete_old_context_documents(180)'
    );
    PERFORM cron.schedule(
      'retention-llm-costs',
      '20 3 * * *',
      'SELECT retention_delete_old_llm_costs(365)'
    );
  END IF;
END $do$;
