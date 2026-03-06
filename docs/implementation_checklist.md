# Slack Sentiment Analysis System — Implementation Checklist

> **Architecture**: LLM-Only | Node.js-Only | Supabase
> **Source**: Claude Code Implementation Blueprint
> **Usage**: Mark `[x]` when complete, `[-]` for in-progress, `[ ]` for not started

---

## Phase A: Foundation (Weeks 1–2)

**Goal**: Persistent PostgreSQL storage, modular codebase, pg-boss job queue. No LLM yet.

### A1. Project Setup

- [x] Create `.gitignore` (include `.env`, `node_modules/`, `dist/`)
- [x] Create `.env.example` with all placeholder values
- [x] Install runtime dependencies: `pnpm add pg pg-boss zod pino dotenv @supabase/supabase-js`
- [x] Install dev dependencies: `pnpm add -D @types/pg node-pg-migrate`
- [x] Verify `tsconfig.json` is correct (ES2022, NodeNext, strict)

### A2. Config & Logging

- [x] Create `src/config.ts` — Zod-validated env loading
- [x] Validate required vars at startup: `SLACK_SIGNING_SECRET`, `DATABASE_URL`
- [x] Validate optional vars: `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`
- [x] App fails to start if required vars missing
- [x] Create `src/utils/logger.ts` — Pino structured logger
- [x] Structured JSON output with correlation IDs
- [x] Log levels: error, warn, info, debug
- [x] Never logs raw message text

### A3. Database Setup

- [x] Create Supabase project and configure
  - [x] Region: closest to primary Slack workspace
  - [x] Enable extensions: `pgcrypto`, `vector`, `pg_cron`
  - [x] Connection pooling mode: Transaction (Supavisor)
  - [x] Copy both direct (port 5432) and pooled (port 6543) connection strings
- [x] Create `src/db/pool.ts` — PostgreSQL connection pool
  - [x] Direct connection for pg-boss (LISTEN/NOTIFY)
  - [x] Pooled connection for application queries

### A4. Migration 001: Foundation Schema

- [x] Write `db/migrations/001_initial_schema.sql`
- [x] `channels` table (workspace_id, channel_id, status, UNIQUE constraint)
- [x] `slack_events` table (workspace_id, event_id, UNIQUE constraint for idempotency)
- [x] `messages` table (workspace_id, channel_id, ts, UNIQUE constraint)
  - [x] Index: `idx_messages_channel` on (workspace_id, channel_id, created_at)
  - [x] Index: `idx_messages_thread` on (workspace_id, channel_id, thread_ts)
  - [x] Index: `idx_messages_analysis` on (analysis_status) WHERE pending
  - [x] Index: `idx_messages_user` on (workspace_id, user_id)
- [x] `thread_edges` table (workspace_id, channel_id, thread_ts, child_ts, UNIQUE)
- [x] `user_profiles` table (workspace_id, user_id, UNIQUE)
- [x] Run migration successfully against Supabase
- [x] Verify all tables exist with correct constraints

### A5. Queue Setup

- [x] Create `src/queue/boss.ts` — pg-boss instance
  - [x] Uses direct (non-pooled) connection string
  - [x] Archive: 7 days for completed jobs
  - [x] Monitor interval: 2 seconds
- [x]Create `src/queue/jobTypes.ts` — job payload type definitions
  - [x] `BackfillJob` type: { workspaceId, channelId, reason }
  - [x] `MessageIngestJob` type: { workspaceId, channelId, ts, eventId }
- [x] Configure concurrency limits
  - [x] `channel.backfill`: concurrency 2, retry 3, backoff 60s
  - [x] `message.ingest`: concurrency 8, retry 3, backoff 10s

### A6. Decompose Monolith (index.ts → modules)

- [x] Extract types → `src/types/slack.ts`
- [x ] Extract signature verification → `src/middleware/slackSignature.ts`
  - [x ] HMAC-SHA256 verification
  - [x ] Timing-safe comparison (`crypto.timingSafeEqual`)
  - [x ] 5-minute timestamp window check
- [x ] Extract Slack API wrapper → `src/services/slackClient.ts`
  - [x ] `slackApiCall` with exponential backoff + jitter
  - [x ] Rate limit (429) handling
- [x ] Extract backfill logic → `src/services/backfill.ts`
  - [x ] `conversations.history` with cursor pagination
  - [x ] `conversations.replies` for threads with reply_count > 0
  - [x ] Thread edge tracking
  - [ x] All inserts use ON CONFLICT DO NOTHING (idempotent)
- [x] Extract routes → `src/routes/slackEvents.ts`
  - [x] URL verification challenge handler
  - [x] Event callback dispatcher
  - [x] `member_joined_channel` → enqueue backfill
  - [ ] `message` → store + enqueue ingest
- [x] Extract routes → `src/routes/channels.ts`
  - [x] GET `/api/channels/:channelId/state`
  - [x] GET `/api/channels/:channelId/messages`
  - [x] POST `/api/channels/:channelId/backfill`
- [x] Extract routes → `src/routes/health.ts`
  - [x] GET `/` — version, uptime, queue stats, channel counts
- [x] Slim down `src/index.ts` to app bootstrap only (~80 lines)

### A7. Replace In-Memory State with Database

- [x] Replace in-memory `channelStates` Map → read/write from `channels` table
- [x] Replace in-memory `messageStore` Map → read/write from `messages` table
- [x] Replace in-memory `threadEdges` Map → read/write from `thread_edges` table
- [x] Replace in-memory `processedEvents` Set → INSERT into `slack_events` ON CONFLICT
- [x] Verify: state persists across app restarts

### A8. Wire pg-boss Jobs

- [x] Create `src/queue/handlers/backfillHandler.ts`
  - [ ] Dequeue `channel.backfill` job
  - [ ] Call backfill service
  - [ ] Set channel status = 'ready' on success, 'failed' on error
- [ ] Create `src/queue/handlers/messageHandler.ts`
  - [ ] Dequeue `message.ingest` job
  - [ ] Fetch message from DB, run basic processing
- [ ] Wire webhook: on `member_joined_channel` → enqueue `channel.backfill`
- [ ] Wire webhook: on `message` → store message + enqueue `message.ingest`
- [ ] Return 200 OK to Slack BEFORE any async processing

### A9. Phase A Verification

- [ ] `curl POST /slack/events` with test payload → message appears in PostgreSQL
- [ ] Invite bot to channel → backfill runs → messages stored in DB
- [ ] Restart app → all state persists (channels, messages, events)
- [ ] Duplicate event → silently dropped (idempotency check works)
- [ ] GET `/api/channels/:channelId/state` returns data from DB
- [ ] GET `/` health check shows queue stats

---

## Phase B: Context Graph + User Profiles (Weeks 3–4)

**Goal**: Complete thread structure, user names, periodic reconciliation.

### B1. User Profile Resolution

- [x] Create `src/services/userProfiles.ts`
  - [x] In-memory Map as hot cache (24-hour TTL)
  - [x] Supabase `user_profiles` table as durable backing
  - [x] Cache check → DB check → Slack `users.info` API call
- [x] Create `user.resolve` job handler
  - [x] Concurrency: 5, retry: 3, backoff: 5s
  - [x] Rate limit: respect Slack 429 with backoff
- [x] Backfill path: batch-resolve unique user IDs (max 5 concurrent)
- [x] Realtime path: on message ingest, check cache → queue `user.resolve` on miss
- [x] API responses include `displayName` (join with user_profiles)

### B2. Bot Identity

- [x] Auto-detect bot user ID via `auth.test` at startup
- [x] Fall back to `SLACK_BOT_USER_ID` env var if API call fails
- [x] Use resolved bot ID for `member_joined_channel` filtering

### B3. Thread Reconciliation

- [x] Create `src/services/threadReconcile.ts`
  - [ ] Periodic 5-minute loop for active threads
  - [ ] Call `conversations.replies` for threads with recent activity
  - [ ] Idempotent upsert of missed replies
- [ ] Create `thread.reconcile` job handler
  - [ ] Concurrency: 3, retry: 2, backoff: 15s
- [ ] Active thread detection: threads with replies in last 24 hours

### B4. Migration 002: Sentiments & Channel State

- [ ] Write `db/migrations/002_sentiments_and_analytics.sql`
- [ ] `message_analytics` table with all fields and constraints
  - [ ] Index: emotion, escalation_risk, channel+time
- [ ] `channel_state` table (one row per channel)
  - [ ] running_summary, participants_json, active_threads_json
  - [ ] key_decisions_json, sentiment_snapshot_json
  - [ ] LLM gating fields: messages_since_last_llm, last_llm_run_at, llm_cooldown_until
- [ ] Run migration successfully

### B5. Channel State Management

- [ ] Build channel_state management functions
  - [ ] Initialize on channel join / backfill
  - [ ] Update participants on new messages
  - [ ] Update active threads on thread activity
- [ ] API endpoints for thread/timeline data
  - [ ] GET `/api/channels/:channelId/threads`
  - [ ] GET `/api/channels/:channelId/timeline`

### B6. Phase B Verification

- [ ] Invite bot → backfill → user names resolved in DB
- [ ] GET `/api/channels/:id/state` shows participants with display names
- [ ] Thread reconcile heals gaps (miss a reply → reconcile finds it)
- [ ] Bot identity auto-detected at startup (check logs)

---

## Phase C: LLM Integration + Sentiment Pipeline (Weeks 5–7)

**Goal**: Working emotion analysis with conditional gating.

### C1. Dependencies

- [ ] Install: `pnpm add openai @anthropic-ai/sdk ajv node-emoji`

### C2. Text Normalization

- [ ] Create `src/services/textNormalizer.ts`
  - [ ] Step 1: Strip user mentions `<@U123>` → remove
  - [ ] Step 2: Resolve channel links `<#C123|general>` → #general
  - [ ] Step 3: Clean URLs `<https://...|label>` → [link]
  - [ ] Step 4: Strip formatting chars (\*, ~, `) — preserve content
  - [ ] Step 5: Convert emoji → text (node-emoji)
  - [ ] Step 6: PRESERVE negation, intensifiers, caps, punctuation (NO-OP)
  - [ ] Step 7: Collapse whitespace
  - [ ] Step 8: Truncate to 4,000 characters
- [ ] Do NOT lowercase, stem, or remove stopwords
- [ ] Unit tests for normalization edge cases

### C3. Prompt Templates

- [ ] Create `src/prompts/singleMessage.ts`
  - [ ] System prompt: emotion classification engine
  - [ ] Context injection slots: running_summary, key_decisions, context_documents
  - [ ] JSON schema in prompt: dominant_emotion, confidence, escalation_risk, explanation
  - [ ] Strict output instructions: no markdown, no code blocks, ONLY JSON
- [ ] Create `src/prompts/threadAnalysis.ts`
  - [ ] Extends single-message with thread_sentiment, sentiment_trajectory, summary

### C4. Emotion Service (LLM Provider Abstraction)

- [ ] Create `src/services/emotionService.ts`
  - [ ] `LLMProvider` interface: analyzeMessage, analyzeThread, generateEmbedding
  - [ ] OpenAI implementation using `openai` SDK
    - [ ] `response_format: { type: 'json_object' }` for JSON enforcement
    - [ ] `temperature: 0.1` (near-deterministic)
    - [ ] `max_tokens: 500`
  - [ ] Anthropic implementation using `@anthropic-ai/sdk`
  - [ ] Provider selection via `LLM_PROVIDER` env var
  - [ ] Model selection via `LLM_MODEL` / `LLM_MODEL_THREAD` env vars
- [ ] JSON schema validation with ajv
  - [ ] MessageAnalysis schema (dominant_emotion enum, confidence 0-1, escalation_risk enum)
  - [ ] ThreadAnalysis schema (extends MessageAnalysis)
  - [ ] On validation failure: retry once with stricter prompt
  - [ ] On second failure: mark as failed, log raw response
- [ ] Strip markdown code fences from LLM response before JSON.parse

### C5. Conditional LLM Gating

- [ ] Create `src/services/llmGate.ts`
  - [ ] Risk heuristic function: keyword scoring + caps detection + punctuation patterns
    - [ ] High-risk keywords: angry, furious, frustrated, unacceptable, terrible, cancel, lawsuit, etc.
    - [ ] Score 0.3 per keyword match (max 3 matches)
    - [ ] ALL CAPS sentences: +0.2
    - [ ] Excessive punctuation (!!!, ???): +0.15 each
    - [ ] Return score 0.0 – 1.0
  - [ ] Trigger condition 1: Risk score ≥ 0.7 → immediate
  - [ ] Trigger condition 2: messages_since_last_llm ≥ 20 → threshold
  - [ ] Trigger condition 3: Time ≥ 10 min since last run AND messages > 0 → time
  - [ ] Trigger condition 4: Manual POST endpoint → bypass cooldown
  - [ ] Cooldown: 60 seconds between automatic triggers per channel
- [ ] Wire into message.ingest handler: evaluate gate → enqueue `llm.analyze` if triggered

### C6. LLM Analyze Job Handler

- [ ] Create `src/queue/handlers/analyzeHandler.ts`
  - [ ] Concurrency: 4, retry: 2, backoff: 30s
  - [ ] Dequeue `llm.analyze` job
  - [ ] Fetch recent messages from DB (last 15 channel / last 25 thread)
  - [ ] Call emotionService.analyzeMessage or analyzeThread
  - [ ] Store result in `message_analytics`
  - [ ] Update `channel_state`: last_llm_run_at, messages_since_last_llm = 0
- [ ] Check alert thresholds after storing result
  - [ ] escalation_risk === 'high' → fire alert
  - [ ] dominant_emotion === 'anger' AND confidence > 0.85 → fire alert

### C7. LLM Cost Tracking

- [ ] Write `db/migrations/004_llm_costs.sql`
- [ ] Run migration
- [ ] Track per-request: provider, model, prompt_tokens, completion_tokens, estimated_cost_usd
- [ ] Daily budget check before each `llm.analyze` job
  - [ ] If daily cost ≥ LLM_DAILY_BUDGET_USD → skip job, log reason, fire alert

### C8. Alerting Service

- [ ] Create `src/services/alerting.ts`
  - [ ] Alert on: escalation_risk high, anger > 0.85, deteriorating trajectory
  - [ ] Alert on: daily LLM cost exceeds budget
  - [ ] MVP delivery: structured JSON log events with severity 'alert'
  - [ ] Future: webhook to internal Slack channel, PagerDuty

### C9. Manual Analysis Endpoint

- [ ] POST `/api/channels/:channelId/analyze`
  - [ ] Accept body: `{ mode: "channel" | "thread", threadTs?: string }`
  - [ ] Bypass cooldown
  - [ ] Enqueue `llm.analyze` job with triggerType = 'manual'

### C10. Phase C Verification

- [ ] Send "I am extremely frustrated with this!" → LLM triggers → `message_analytics` row appears
- [ ] Send "sounds good, thanks" → LLM does NOT trigger (gating works)
- [ ] Send 20 neutral messages → LLM triggers on 20th (threshold works)
- [ ] Wait 10 min with messages pending → LLM triggers (time trigger works)
- [ ] POST manual analyze → LLM triggers immediately (manual works)
- [ ] LLM returns bad JSON → retry happens → second failure marked as failed
- [ ] `llm_costs` table has cost records for each analysis
- [ ] Switch `LLM_PROVIDER=anthropic` → restart → analysis works with Claude

---

## Phase D: Context Management + Summarization (Weeks 8–9)

**Goal**: Intelligent context packs, running summaries, semantic retrieval.

### D1. Migration 003: Context Documents + pgvector

- [x] Write `db/migrations/003_context_documents_pgvector.sql`
- [x] `context_documents` table with `embedding vector(1536)`
- [x] IVFFlat index for cosine similarity
- [x] Run migration successfully
- [x] Verify pgvector extension is active

### D2. Incremental Summarizer

- [x] Create `src/services/summarizer.ts`
  - [x] Channel rollup: triggered every 20 messages OR 10 minutes
    - [x] Collect messages since last rollup
    - [x] LLM call: "Summarize into concise paragraph, preserve key decisions"
    - [x] Merge with existing running_summary via LLM
    - [x] Generate embedding via `text-embedding-3-small`
    - [x] Store in `context_documents` (doc_type = 'channel_rollup')
    - [x] Update `channel_state.running_summary`
  - [x] Thread rollup: triggered every 10 replies OR 15 min idle
    - [x] Summarize thread, store as context document
  - [x] Backfill summarization (hierarchical compression)
    - [x] Split messages into batches of 200
    - [x] Summarize each batch → meta-summarize → final summary
    - [x] Store intermediate summaries as context documents with embeddings

### D3. Context Assembler

- [x] Create `src/services/contextAssembler.ts`
  - [x] Token budget: 3,500 tokens
  - [x] Layer 1: Running summary (NEVER truncated) — ~200 tokens
  - [x] Layer 2: Key decisions (last 10) — ~100 tokens
  - [x] Layer 3: Top 3 pgvector matches (cosine similarity) — ~600 tokens
  - [x] Layer 4: Target messages (last 15 channel / 25 thread) — remainder
  - [x] Truncation: remove oldest raw messages first, never remove summary
  - [x] Token estimation: ~1 token per 4 characters

### D4. Rollup Job Handler

- [x] Create `src/queue/handlers/rollupHandler.ts`
  - [x] `summary.rollup` job: concurrency 3, retry 2, backoff 30s
  - [x] Channel rollup trigger logic
  - [x] Thread rollup trigger logic
- [x] Wire rollup triggers into message.ingest flow

### D5. Wire Context into LLM Calls

- [x] Update `analyzeHandler.ts` to use contextAssembler
  - [x] Build context pack before LLM call
  - [x] LLM now receives: summary + pgvector matches + recent messages
  - [x] Not just raw messages alone

### D6. Phase D Verification

- [x] After backfill → channel has running_summary in channel_state
- [x] After 20+ messages → rollup fires → `context_documents` populated
- [x] pgvector query returns semantically relevant documents
- [x] LLM responses reference historical context (not just immediate messages)
- [x] Thread rollup stores thread summary with embedding

---

## Phase E: Analytics + Hardening (Weeks 10–11)

**Goal**: Production-ready with monitoring, retention, and full API surface.

### E1. Analytics API

- [x] Create `src/routes/analytics.ts` (consolidated analytics endpoints)
  - [x] GET `/api/analytics/sentiment-trends?granularity=hourly|daily` — time-series trends
  - [x] GET `/api/analytics/costs?from=&to=` — LLM cost tracking
  - [x] GET `/api/analytics/overview` — dashboard stats
  - [x] GET `/api/channels/:id/analytics` — per-channel analytics
  - [x] GET `/api/channels/:id/summary` — channel summary with rollup stats

### E2. Data Retention

- [x] Migration 005: retention functions for all tables
- [x] pg_cron schedules: daily at 3 AM UTC (staggered by 5 min)
- [x] Configurable retention days via env vars (MESSAGE_RETENTION_DAYS, ANALYTICS_RETENTION_DAYS)
- [x] Graceful fallback when pg_cron not available

### E3. Input Validation

- [x] Add zod schemas for all API request bodies
- [x] Add zod schemas for all query parameters
- [x] Validate at route level, return 400 with clear error on failure

### E4. Rate Limiting

- [ ] Per-workspace rate limit on webhook endpoint (1000 req/min) — deferred
- [ ] Per-API-key rate limit on analytics endpoints — deferred

### E5. Error Handling

- [x] Structured error handling middleware (centralized in index.ts)
  - [x] Logs full error internally (without message text)
  - [x] Returns sanitized error to client (no stack traces in production)
- [x] Startup recovery: query channels with status='initializing' → re-enqueue backfill

### E6. Observability

- [x] Structured logging with pino across all modules
  - [x] Fields: correlationId, workspaceId, channelId, action, duration_ms
  - [x] Never log raw message text
- [x] Health check endpoint enhanced
  - [x] Version, uptime, queue stats (active/waiting/failed), channel counts
- [ ] Metrics (optional: prom-client for Prometheus) — deferred

### E7. Docker & Deployment

- [x] Create `Dockerfile` (Node.js 22 Alpine, multi-stage)
- [x] Create `docker-compose.yml` (app + postgres with pgvector)
- [x] Health check on GET `/health/live`
- [x] Auto-restart on crash (unless-stopped policy)

### E8. Testing

- [x] Integration tests: webhook → backfill → analyze → query (E2E fullFlow.test.ts)
- [x] Route tests: channels (14), analytics (6), slackEvents (5), health (6)
- [x] Handler tests: messageHandler (5), analyzeHandler (5), rollupHandler (4)
- [x] Service tests: contextAssembler (4), llmGate (11), riskHeuristic (18)
- [ ] Load test: simulate 50 active channels — deferred
- [ ] Chaos tests — deferred

### E9. Phase E Verification

- [x] GET `/api/analytics/sentiment-trends` returns time-series data
- [x] GET `/api/analytics/costs` returns cost breakdown
- [x] Data retention functions created (check pg_cron for auto-scheduling)
- [x] Docker compose config created for full stack
- [x] App recovers stuck channels on restart
- [x] Invalid API input returns 400 with clear error

---

## End-to-End Validation Checklist

- [x] Configure Slack app with webhook URL (ngrok for local dev)
- [x] Invite bot to test channel with existing conversation history
- [x] Backfill completes → `channels.status = 'ready'`
- [x] User display names appear in API responses
- [x] Send emotional messages → sentiment results in `message_analytics`
- [x] Conditional gating works (neutral = no LLM, angry = LLM triggers)
- [x] Thread analysis works (multi-message thread context)
- [x] Context pack includes running summary + historical context
- [x] Query analytics API → aggregated trends returned
- [x] Check `llm_costs` → cost tracking records present
- [x] Restart app → all state persists (+ startup recovery for stuck channels)
- [x] Switch LLM provider via env var → analysis continues working (openai | gemini)

---

## Configuration Reference

```

# Slack
SLACK_SIGNING_SECRET=           # Required
SLACK_BOT_TOKEN=                # Required for backfill
SLACK_BOT_USER_ID=              # Optional (auto-detected via auth.test)
BACKFILL_DAYS=30
SLACK_PAGE_SIZE=200
BACKFILL_MAX_PAGES=100

# Database
DATABASE_URL=                   # Direct connection (pg-boss)
DATABASE_URL_POOLED=            # Pooled connection (app queries)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# LLM
LLM_PROVIDER=openai             # openai | anthropic
LLM_MODEL=gpt-4o-mini           # Single-message model
LLM_MODEL_THREAD=gpt-4o         # Thread analysis model
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# LLM Gating
LLM_MSG_THRESHOLD=20
LLM_TIME_THRESHOLD_MIN=10
LLM_COOLDOWN_SEC=60
LLM_RISK_THRESHOLD=0.7
LLM_DAILY_BUDGET_USD=10.00

# Server
PORT=3000
LOG_LEVEL=info
MESSAGE_RETENTION_DAYS=90
```

---

_Total items: ~150 checkboxes across 5 phases_
_Estimated timeline: 11 weeks_
_Mark [x] when done, [-] for in-progress, [ ] for not started_
