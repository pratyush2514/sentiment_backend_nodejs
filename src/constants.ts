// ─── Workspace ───────────────────────────────────────────────────────────────
export const DEFAULT_WORKSPACE = "default";

// ─── Message limits ──────────────────────────────────────────────────────────
export const CHANNEL_MESSAGE_LIMIT = 15;
export const THREAD_MESSAGE_LIMIT = 25;
export const TARGET_MESSAGE_COUNT = 5;
export const THREAD_ROLLUP_LIMIT = 50;
export const BACKFILL_BATCH_SIZE = 200;
export const MAX_DECISIONS = 20;

// ─── Slack API ───────────────────────────────────────────────────────────────
export const SLACK_MAX_RETRIES = 5;
export const SLACK_JITTER_MS = 250;

// ─── User profile cache ─────────────────────────────────────────────────────
export const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PROFILE_MAX_CACHE_SIZE = 10_000;

// ─── Thread reconciliation ──────────────────────────────────────────────────
export const RECONCILE_BASE_INTERVAL_MS = 5 * 60 * 1000;
export const RECONCILE_JITTER_MS = 30_000;
export const RECONCILE_ACTIVE_THREAD_HOURS = 24;
export const RECONCILE_MAX_PAGES = 10;

// ─── Text processing ────────────────────────────────────────────────────────
export const MAX_NORMALIZED_TEXT_LENGTH = 4_000;

// ─── LLM defaults ───────────────────────────────────────────────────────────
export const LLM_TEMPERATURE = 0.1;
export const LLM_MAX_TOKENS = 500;

// ─── Context assembly token budget percentages ──────────────────────────────
export const CONTEXT_LAYER_SUMMARY_PCT = 0.30;
export const CONTEXT_LAYER_DECISIONS_PCT = 0.10;
export const CONTEXT_LAYER_DOCUMENTS_PCT = 0.35;
export const CONTEXT_LAYER_MESSAGES_PCT = 0.25;
