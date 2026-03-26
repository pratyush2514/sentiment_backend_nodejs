import "dotenv/config";
import { z } from "zod/v4";
import { envBoolean } from "./utils/envBoolean.js";

const envSchema = z.object({
  // Slack
  SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
  SLACK_CLIENT_ID: z.string().optional().default(""),
  SLACK_CLIENT_SECRET: z.string().optional().default(""),
  SLACK_BOT_TOKEN: z.string().optional().default(""),
  SLACK_BOT_USER_ID: z.string().optional().default(""),
  BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  SLACK_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(100),
  SLACK_TOKEN_REFRESH_BUFFER_MINUTES: z.coerce.number().int().positive().default(10),
  SLACK_TOKEN_REFRESH_LOOKAHEAD_MINUTES: z.coerce.number().int().positive().default(15),
  SLACK_TOKEN_REFRESH_SWEEP_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),

  // Database — direct connection for pg-boss (LISTEN/NOTIFY)
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Pooled connection for application queries (optional, falls back to DATABASE_URL)
  DATABASE_URL_POOLED: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DIRECT_DB_POOL_MAX: z.coerce.number().int().positive().default(2),
  PGBOSS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),

  // Supabase client (optional — used for convenience queries)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().optional().default(""),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RUNTIME_ROLE: z
    .enum(["all", "web", "worker", "scheduler"])
    .default("all"),
  RUN_MIGRATIONS_ON_BOOT: envBoolean(),

  // API Authentication (required in production, enforced by middleware)
  API_AUTH_TOKEN: z.string().optional(),

  // Supabase Auth JWT verification (for PulseBoard frontend)
  SUPABASE_JWT_SECRET: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().default("*"),

  // SSE
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),

  // Proxy & Timeouts
  TRUST_PROXY: envBoolean(false),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HEALTHCHECK_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  HEALTHCHECK_MIGRATION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  QUEUE_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  QUEUE_STALE_CHANNEL_MINUTES: z.coerce.number().int().positive().default(10),
  QUEUE_STALE_ANALYSIS_MINUTES: z.coerce.number().int().positive().default(15),
  QUEUE_STALE_SCAN_LIMIT: z.coerce.number().int().positive().default(50),
  INTELLIGENCE_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  INTELLIGENCE_RECONCILE_SCAN_LIMIT: z.coerce.number().int().positive().default(50),

  // LLM Provider — set LLM_PROVIDER and supply the matching API key
  LLM_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  LLM_MODEL: z.string().optional(),         // Auto-defaults per provider if not set
  LLM_MODEL_THREAD: z.string().optional(),  // Auto-defaults per provider if not set
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  // Embedding
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  // Rollup Thresholds
  ROLLUP_MSG_THRESHOLD: z.coerce.number().int().positive().default(20),
  ROLLUP_TIME_THRESHOLD_MIN: z.coerce.number().int().positive().default(10),
  ROLLUP_THREAD_REPLY_THRESHOLD: z.coerce.number().int().positive().default(10),
  THREAD_HOT_REPLY_THRESHOLD: z.coerce.number().int().positive().default(5),
  THREAD_HOT_WINDOW_MIN: z.coerce.number().int().positive().default(3),
  THREAD_INSIGHT_ROUTE_REFRESH_COOLDOWN_SEC: z.coerce.number().int().positive().default(20),

  // Context Assembly
  CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(3500),

  // LLM Gating
  LLM_MSG_THRESHOLD: z.coerce.number().int().positive().default(20),
  LLM_TIME_THRESHOLD_MIN: z.coerce.number().int().positive().default(10),
  LLM_COOLDOWN_SEC: z.coerce.number().int().positive().default(60),
  LLM_RISK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(10.0),
  REALTIME_LLM_DEBOUNCE_SEC: z.coerce.number().int().positive().default(3),

  // Channel member sync
  CHANNEL_MEMBER_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),

  // Follow-up reminders
  FOLLOW_UP_SWEEP_MS: z.coerce.number().int().positive().default(60_000),
  FOLLOW_UP_DEFAULT_SLA_HOURS: z.coerce.number().positive().default(48),
  FOLLOW_UP_ALERT_REPEAT_HOURS: z.coerce.number().positive().default(6),
  FOLLOW_UP_REPLY_GRACE_MINUTES: z.coerce.number().int().positive().default(3),
  FOLLOW_UP_ACK_EXTENSION_HOURS: z.coerce.number().positive().default(12),
  FOLLOW_UP_CROSS_THREAD_REPLY_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
  FOLLOW_UP_IGNORE_SCORE_THRESHOLD: z.coerce.number().int().positive().default(3),
  FOLLOW_UP_SILENT_CLOSE_LOW_HOURS: z.coerce.number().positive().default(24),
  FOLLOW_UP_SILENT_CLOSE_MEDIUM_HOURS: z.coerce.number().positive().default(72),
  FOLLOW_UP_MAX_AGE_HOURS: z.coerce.number().positive().default(168),         // 7 days — auto-expire stale items
  FOLLOW_UP_MAX_NUDGE_COUNT: z.coerce.number().int().positive().default(12),  // Stop DMs after this many nudges
  FOLLOW_UP_ACK_REACTIONS: z.string().default("+1,white_check_mark,eyes,heavy_check_mark,thumbsup,pray"),

  // Default analysis window when a channel policy does not set one explicitly
  SUMMARY_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  LOW_SIGNAL_CHANNEL_NAMES: z.string().default("general,random,social,watercooler"),
  AUTOMATION_CHANNEL_KEYWORDS: z.string().default("error,errors,alert,alerts,incident,incidents,monitor,monitoring,n8n"),

  // Data Retention
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

  // Privacy Filter
  PRIVACY_MODE: z.enum(["off", "redact", "skip"]).default("redact"),

  // Token Encryption (required for multi-tenant workspace token storage)
  ENCRYPTION_KEY: z.string().optional().default(""),

  // Fathom Meeting Integration
  FATHOM_ENABLED: envBoolean(false),
  FATHOM_ALLOW_INSECURE_WEBHOOKS: envBoolean(false),
  FATHOM_WEBHOOK_SECRET: z.string().optional().default(""),
  FATHOM_DEFAULT_OBLIGATION_SLA_HOURS: z.coerce.number().positive().default(72),
  FATHOM_MAX_TRANSCRIPT_TOKENS: z.coerce.number().int().positive().default(8000),
  FATHOM_HISTORICAL_SYNC_STALE_MINUTES: z.coerce.number().int().positive().default(45),

  // Channel Classification
  LLM_INFRA_BUDGET_USD: z.coerce.number().positive().default(5.0),
  CLASSIFICATION_RERUN_DAYS: z.coerce.number().int().positive().default(7),
  CLASSIFICATION_LLM_ENABLED: envBoolean(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

// ─── Provider-aware model defaults ──────────────────────────────────────────

const MODEL_DEFAULTS = {
  openai: { model: "gpt-4o-mini", threadModel: "gpt-4o" },
  gemini: { model: "gemini-2.0-flash", threadModel: "gemini-2.5-pro" },
} as const;

const defaults = MODEL_DEFAULTS[parsed.data.LLM_PROVIDER];

// Cross-validate: ensure the selected LLM provider has its API key
if (parsed.data.LLM_PROVIDER === "openai" && !parsed.data.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  process.exit(1);
}
if (parsed.data.LLM_PROVIDER === "gemini" && !parsed.data.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
  process.exit(1);
}

if (parsed.data.NODE_ENV === "production") {
  if (!parsed.data.SLACK_CLIENT_ID || !parsed.data.SLACK_CLIENT_SECRET) {
    console.error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required in production");
    process.exit(1);
  }

  if (!parsed.data.API_AUTH_TOKEN && !parsed.data.SUPABASE_JWT_SECRET) {
    console.error(
      "Either API_AUTH_TOKEN or SUPABASE_JWT_SECRET is required in production",
    );
    process.exit(1);
  }

  if (parsed.data.CORS_ORIGIN === "*") {
    console.error("CORS_ORIGIN cannot be '*' in production");
    process.exit(1);
  }

  if (parsed.data.FATHOM_ENABLED) {
    if (!parsed.data.PUBLIC_BASE_URL) {
      console.error("PUBLIC_BASE_URL is required when FATHOM_ENABLED=true in production");
      process.exit(1);
    }
    if (!parsed.data.ENCRYPTION_KEY || parsed.data.ENCRYPTION_KEY.length !== 64) {
      console.error(
        "ENCRYPTION_KEY must be a 64-character hex string when FATHOM_ENABLED=true in production.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
      process.exit(1);
    }
    if (parsed.data.FATHOM_ALLOW_INSECURE_WEBHOOKS) {
      console.error("FATHOM_ALLOW_INSECURE_WEBHOOKS cannot be enabled in production");
      process.exit(1);
    }
    if (!parsed.data.FATHOM_WEBHOOK_SECRET) {
      console.warn(
        "WARNING: FATHOM_WEBHOOK_SECRET not set — webhooks will be rejected in production",
      );
    }
  }
}

export const config = {
  ...parsed.data,
  RUN_MIGRATIONS_ON_BOOT:
    parsed.data.RUN_MIGRATIONS_ON_BOOT ?? parsed.data.NODE_ENV !== "production",
  LLM_MODEL: parsed.data.LLM_MODEL ?? defaults.model,
  LLM_MODEL_THREAD: parsed.data.LLM_MODEL_THREAD ?? defaults.threadModel,
  LOW_SIGNAL_CHANNEL_NAMES: parsed.data.LOW_SIGNAL_CHANNEL_NAMES
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0),
  AUTOMATION_CHANNEL_KEYWORDS: parsed.data.AUTOMATION_CHANNEL_KEYWORDS
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0),
};
