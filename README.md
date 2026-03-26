# Slack Sentiment Analysis Bot

Real-time emotion and escalation-risk analysis for Slack workspaces. Monitors channel conversations, detects sentiment patterns, maintains rolling summaries, and surfaces analytics through a REST API.

## Architecture

- **Runtime**: Node.js 22, TypeScript, Express 5
- **Database**: PostgreSQL (Supabase) with pgvector for semantic retrieval
- **Queue**: pg-boss for reliable background job processing
- **LLM Providers**: OpenAI and Google Gemini (configurable)

### Core Pipeline

```
Slack Event → Signature Verify → Dedupe → Enqueue message.ingest
  → Store message + normalize text
  → Evaluate LLM gate (risk/threshold/time/manual)
  → If triggered: enqueue llm.analyze → emotion analysis → store analytics
  → If rollup threshold: enqueue summary.rollup → update running summary
```

### Background Jobs

| Job | Purpose |
|-----|---------|
| `channel.backfill` | Bootstrap channel history on bot join |
| `message.ingest` | Process realtime messages |
| `llm.analyze` | Run emotion/escalation analysis |
| `summary.rollup` | Maintain rolling channel/thread summaries |
| `thread.reconcile` | Heal missed thread replies |
| `user.resolve` | Resolve Slack user profiles |

### Fathom Meeting Pipeline

When `FATHOM_ENABLED=true`, PulseBoard runs a separate meeting intelligence pipeline:

```
Fathom webhook -> meeting.ingest
  -> exact channel resolution + meeting snapshot flags
  -> meeting.extract
  -> meeting.digest (optional)
  -> meeting.obligation_sync (optional)
```

Operational notes:

- Set `PUBLIC_BASE_URL` so webhook URLs are generated from trusted config instead of request headers.
- Keep `FATHOM_ALLOW_INSECURE_WEBHOOKS=false` outside isolated local development.
- `digest_enabled` and `tracking_enabled` are snapped onto each meeting when it is linked so retries stay deterministic.
- Use the repair CLI below after rollout if you need to clear stale digest claims, merge legacy duplicate obligations, encrypt old plaintext webhook secrets, or audit legacy pattern-based channel links.

## Quick Start

### Prerequisites

- Node.js >= 22
- pnpm
- PostgreSQL with pgvector extension (or Supabase project)
- Slack app with Event Subscriptions enabled

### Setup

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Run in development mode (auto-runs migrations)
pnpm run dev
```

### Docker

```bash
# Build and run with Docker Compose
docker compose up --build

# Or build standalone
docker build -t slack-sentiment-bot .
docker run --env-file .env -p 3000:3000 slack-sentiment-bot
```

### Slack App Configuration

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Event Subscriptions** with request URL: `https://your-host/slack/events`
3. Subscribe to bot events: `message.channels`, `member_joined_channel`
4. Add bot scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `team:read`
5. Add write scopes if you use reminders or DM nudges: `chat:write`, `im:write`
6. Install to workspace
7. Copy Signing Secret to `SLACK_SIGNING_SECRET`
8. For production multi-workspace installs, use the OAuth install flow so PulseBoard stores a refresh token and token expiry metadata
9. Invite the bot to channels you want monitored

### Production runtime modes

PulseBoard supports split runtime roles through `RUNTIME_ROLE`:

- `web` — HTTP API, Slack events, SSE
- `worker` — pg-boss workers and async processing
- `scheduler` — reconcile, retention, follow-up, and token rotation sweeps
- `all` — everything in one process (acceptable for small internal environments)

Recommended production deployment:

- run migrations once before deploy
- deploy separate `web`, `worker`, and `scheduler` processes
- use a direct Postgres connection string for `DATABASE_URL`
- use `DATABASE_URL_POOLED` only for application queries if you add a pooler later

## API Endpoints

All `/api/*` endpoints require either:

- `Authorization: Bearer <API_AUTH_TOKEN>`
- or a valid Supabase JWT when `SUPABASE_JWT_SECRET` is configured

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/live` | Liveness check |
| GET | `/health/ready` | Readiness (DB + queue) |

### Channels

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/:id/state` | Channel state with participants |
| GET | `/api/channels/:id/messages` | Messages with optional thread view |
| GET | `/api/channels/:id/threads` | Active threads with enriched replies |
| GET | `/api/channels/:id/analytics` | Per-message emotion analytics |
| GET | `/api/channels/:id/summary` | Channel summary with rollup stats |
| POST | `/api/channels/:id/backfill` | Trigger manual backfill |
| POST | `/api/channels/:id/analyze` | Trigger manual LLM analysis |

### Analytics (workspace-level)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/overview` | Dashboard stats |
| GET | `/api/analytics/sentiment-trends` | Emotion trends by hour/day |
| GET | `/api/analytics/costs` | LLM cost breakdown |

## Scripts

```bash
pnpm run dev          # Development with hot reload
pnpm run build        # Compile TypeScript
pnpm run start        # Run compiled output
pnpm run start:web    # Run compiled output as web role
pnpm run start:worker # Run compiled output as worker role
pnpm run start:scheduler # Run compiled output as scheduler role
pnpm run start:prod:web
pnpm run start:prod:worker
pnpm run start:prod:scheduler
pnpm run fathom:repair -- --scope stale-digests --all
pnpm run test         # Run tests
pnpm run test:watch   # Watch mode
pnpm run typecheck    # Type check without emit
pnpm run lint         # ESLint
pnpm run lint:fix     # ESLint with auto-fix
```

## Configuration

See [.env.example](.env.example) for all environment variables. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | `openai` or `gemini` |
| `LLM_DAILY_BUDGET_USD` | `10.00` | Daily LLM spend cap |
| `LLM_MSG_THRESHOLD` | `20` | Messages before auto-triggering analysis |
| `LLM_RISK_THRESHOLD` | `0.7` | Risk score for immediate trigger |
| `ROLLUP_MSG_THRESHOLD` | `20` | Messages before channel rollup |
| `MESSAGE_RETENTION_DAYS` | `90` | Auto-delete messages after N days |
| `ANALYTICS_RETENTION_DAYS` | `180` | Auto-delete analytics after N days |
| `PUBLIC_BASE_URL` | `""` | Trusted public base URL for OAuth/webhook callbacks |
| `FATHOM_ENABLED` | `false` | Enables the Fathom meeting pipeline |
| `FATHOM_ALLOW_INSECURE_WEBHOOKS` | `false` | Explicit local-only bypass for webhook signature checks |

### Fathom repair CLI

Dry-run by default:

```bash
pnpm run fathom:repair -- --scope stale-digests --all
pnpm run fathom:repair -- --scope dedupe-obligations --workspace <workspace_id>
pnpm run fathom:repair -- --scope encrypt-webhook-secrets --all
pnpm run fathom:repair -- --scope audit-channel-links --all
```

Add `--apply` to execute the repair instead of previewing it.

## Data Retention

Automated cleanup via PostgreSQL functions (migration 005). Requires pg_cron extension for scheduling; falls back gracefully without it. Functions can also be called manually:

```sql
SELECT retention_delete_old_messages(90);
SELECT retention_delete_old_analytics(180);
SELECT retention_delete_old_events(30);
```

## Documentation

- [System Walkthrough](docs/phase-f-system-walkthrough.md) — full architecture reference
- [Implementation Plan](docs/implementation-plan.md) — original design document
- [Security Policy](SECURITY.md) — security practices and reporting
