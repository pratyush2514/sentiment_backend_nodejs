import "dotenv/config";
import { z } from "zod/v4";

const envSchema = z.object({
  // Slack
  SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
  SLACK_BOT_TOKEN: z.string().optional().default(""),
  SLACK_BOT_USER_ID: z.string().optional().default(""),
  BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  SLACK_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(100),

  // Database — direct connection for pg-boss (LISTEN/NOTIFY)
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Pooled connection for application queries (optional, falls back to DATABASE_URL)
  DATABASE_URL_POOLED: z.string().optional(),

  // Supabase client (optional — used for convenience queries)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // API Authentication (required in production, enforced by middleware)
  API_AUTH_TOKEN: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().default("*"),

  // Proxy & Timeouts
  TRUST_PROXY: z.coerce.boolean().default(false),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HEALTHCHECK_DB_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

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

  // Context Assembly
  CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(3500),

  // LLM Gating
  LLM_MSG_THRESHOLD: z.coerce.number().int().positive().default(20),
  LLM_TIME_THRESHOLD_MIN: z.coerce.number().int().positive().default(10),
  LLM_COOLDOWN_SEC: z.coerce.number().int().positive().default(60),
  LLM_RISK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(10.0),

  // Data Retention
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

  // Privacy Filter
  PRIVACY_MODE: z.enum(["off", "redact", "skip"]).default("redact"),
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

export const config = {
  ...parsed.data,
  LLM_MODEL: parsed.data.LLM_MODEL ?? defaults.model,
  LLM_MODEL_THREAD: parsed.data.LLM_MODEL_THREAD ?? defaults.threadModel,
};
