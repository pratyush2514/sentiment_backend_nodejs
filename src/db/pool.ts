import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Direct connection — used by pg-boss (LISTEN/NOTIFY) and migrations
export const directPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
});

// Pooled connection — used for application queries
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL_POOLED ?? config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  statement_timeout: config.REQUEST_TIMEOUT_MS,
  idle_in_transaction_session_timeout: config.REQUEST_TIMEOUT_MS,
});

// Supabase JS client (optional — for convenience queries)
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
    _supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    return _supabase;
  }
  return null;
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await directPool.connect();
  try {
    // Ensure migration tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Find already-applied migrations
    const applied = await client.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    // Run only new migrations
    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.debug({ migration: file }, "Migration already applied, skipping");
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      logger.info({ migration: file }, "Running migration");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1)`,
          [file],
        );
        await client.query("COMMIT");
        logger.info({ migration: file }, "Migration complete");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    const result = await pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  } catch (err) {
    logger.error({ err }, "Database connection check failed");
    return false;
  }
}

export async function shutdown(): Promise<void> {
  await pool.end();
  await directPool.end();
  logger.info("Database pools closed");
}
