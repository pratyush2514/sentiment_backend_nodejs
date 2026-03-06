# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately.
Do NOT open a public GitHub issue.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

## Security Practices

### Authentication & Authorization

- Slack webhook signatures verified using HMAC-SHA256 with timing-safe comparison and 5-minute timestamp drift check
- API endpoints (`/api/channels`, `/api/analytics`) require Bearer token authentication
- Bot identity resolved via `auth.test` for event filtering

### Data Protection

- Database credentials, tokens, and auth headers are never logged (Pino redaction paths)
- Raw message text is never logged — only metadata and analysis results
- Error responses are sanitized in production (no stack traces or internals)
- `.env.example` contains only placeholder values — no real secrets

### Data Retention

- Automated data lifecycle via PostgreSQL retention functions (migration 005)
- Default retention: messages 90 days, analytics 180 days, events 30 days, LLM costs 365 days
- pg_cron schedules (daily 3 AM UTC) with graceful fallback if extension unavailable
- Context documents retained 180 days

### Infrastructure

- Docker images run as non-root user (`appuser`)
- Multi-stage Docker build minimizes attack surface
- Helmet security headers enabled
- CORS origin configurable via environment variable
- Graceful shutdown drains queue and closes connections safely

### Supply Chain

- Dependencies are monitored via Dependabot
- Secret scanning enforced in CI
- `pnpm-lock.yaml` ensures reproducible builds
