import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_LOCK_KEY = 17430120;

// Direct connection — used for migrations only (pg-boss has its own pool)
export const directPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DIRECT_DB_POOL_MAX,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Pooled connection — used for application queries
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL_POOLED ?? config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: config.REQUEST_TIMEOUT_MS,
  idle_in_transaction_session_timeout: config.REQUEST_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Handle idle connection errors gracefully.
// When Supabase PgBouncer closes idle connections, pg emits an error on the
// pool. Without this handler, the error becomes an uncaught exception and
// crashes the process. The pool automatically removes the dead connection
// and creates a new one on the next query.
pool.on("error", (err) => {
  logger.warn({ err: err.message, code: (err as NodeJS.ErrnoException).code }, "Pool idle client error (connection will be replaced)");
});

directPool.on("error", (err) => {
  logger.warn({ err: err.message, code: (err as NodeJS.ErrnoException).code }, "Direct pool idle client error (connection will be replaced)");
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

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function resolveMigrationsDir(): string {
  const candidates = [
    path.join(__dirname, "migrations"),
    path.resolve(process.cwd(), "dist/db/migrations"),
    path.resolve(process.cwd(), "src/db/migrations"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(
    `Migration directory not found. Checked: ${candidates.join(", ")}`,
  );
}

function listMigrationFiles(): string[] {
  const migrationsDir = resolveMigrationsDir();
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export async function getMigrationStatus(): Promise<{
  applied: string[];
  pending: string[];
  upToDate: boolean;
}> {
  const client = await directPool.connect();
  try {
    await ensureMigrationTable(client);
    const files = listMigrationFiles();
    const appliedResult = await client.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    const applied = appliedResult.rows.map((row) => row.filename);
    const appliedSet = new Set(applied);
    const pending = files.filter((file) => !appliedSet.has(file));

    return {
      applied,
      pending,
      upToDate: pending.length === 0,
    };
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const files = listMigrationFiles();

  const client = await directPool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(client);

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
    await client
      .query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
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

export async function checkDirectConnection(): Promise<boolean> {
  try {
    const result = await directPool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  } catch (err) {
    logger.error({ err }, "Direct database connection check failed");
    return false;
  }
}

export async function shutdown(): Promise<void> {
  await pool.end();
  await directPool.end();
  logger.info("Database pools closed");
}
