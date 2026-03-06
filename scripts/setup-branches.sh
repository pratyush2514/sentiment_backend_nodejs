#!/bin/bash
set -e

# PR 3: chore/docker-deploy (6 files)
git checkout -b chore/docker-deploy
git add Dockerfile .dockerignore docker-compose.yml .github/workflows/deploy.yml .github/dependabot.yml GIT-OS.md
git commit -m "chore: Add Docker, deploy workflow, and project docs"

# PR 4: feat/core-foundation (6 files)
git checkout -b feat/core-foundation
git add src/config.ts src/constants.ts src/types/slack.ts src/types/express.d.ts src/types/database.ts src/utils/logger.ts
git commit -m "feat: Add application config, types, and logger"

# PR 5: feat/database-core (5 files)
git checkout -b feat/database-core
git add src/db/pool.ts src/db/queries.ts src/db/migrate.ts src/db/migrations/001_initial_schema.sql scripts/truncate-all.ts
git commit -m "feat: Add database pool, queries, and initial migration"

# PR 6: feat/database-migrations (4 files)
git checkout -b feat/database-migrations
git add src/db/migrations/002_message_analytics.sql src/db/migrations/003_context_documents.sql src/db/migrations/004_llm_costs.sql src/db/migrations/005_data_retention.sql
git commit -m "feat: Add analytics, documents, costs, and retention migrations"

# PR 7: feat/middleware-slack (6 files)
git checkout -b feat/middleware-slack
git add src/middleware/apiAuth.ts src/middleware/slackSignature.ts src/services/textNormalizer.ts src/services/privacyFilter.ts src/services/slackClient.ts src/services/userProfiles.ts
git commit -m "feat: Add middleware and Slack integration services"

# PR 8: feat/llm-services (6 files)
git checkout -b feat/llm-services
git add src/services/llmHelpers.ts src/services/llmProviders.ts src/services/llmGate.ts src/services/costEstimator.ts src/services/embeddingProvider.ts src/services/contextAssembler.ts
git commit -m "feat: Add LLM provider abstraction and services"

# PR 9: feat/prompts-analysis (6 files)
git checkout -b feat/prompts-analysis
git add src/prompts/singleMessage.ts src/prompts/threadAnalysis.ts src/prompts/channelRollup.ts src/prompts/threadRollup.ts src/services/emotionAnalyzer.ts src/services/summarizer.ts
git commit -m "feat: Add prompt templates and analysis services"

# PR 10: feat/queue-core (6 files)
git checkout -b feat/queue-core
git add src/queue/jobTypes.ts src/queue/boss.ts src/queue/handlers/messageHandler.ts src/queue/handlers/analyzeHandler.ts src/queue/handlers/rollupHandler.ts src/queue/handlers/reconcileHandler.ts
git commit -m "feat: Add PgBoss job queue with core handlers"

# PR 11: feat/background-services (6 files)
git checkout -b feat/background-services
git add src/queue/handlers/backfillHandler.ts src/queue/handlers/userResolveHandler.ts src/services/backfill.ts src/services/threadReconcile.ts src/services/riskHeuristic.ts src/services/alerting.ts
git commit -m "feat: Add background processing services"

# PR 12: feat/routes-entry (5 files)
git checkout -b feat/routes-entry
git add src/routes/health.ts src/routes/channels.ts src/routes/analytics.ts src/routes/slackEvents.ts src/index.ts
git commit -m "feat: Add API routes and Express entry point"

# PR 13: test/unit-tests (5 files)
git checkout -b test/unit-tests
git add src/types/slack.test.ts src/middleware/apiAuth.test.ts src/middleware/slackSignature.test.ts src/services/textNormalizer.test.ts src/services/privacyFilter.test.ts
git commit -m "test: Add type and middleware unit tests"

# PR 14: test/service-tests (6 files)
git checkout -b test/service-tests
git add src/services/riskHeuristic.test.ts src/services/llmGate.test.ts src/services/contextAssembler.test.ts src/queue/handlers/analyzeHandler.test.ts src/queue/handlers/rollupHandler.test.ts src/queue/handlers/messageHandler.test.ts
git commit -m "test: Add service and handler tests"

# PR 15: test/route-e2e-tests (5 files)
git checkout -b test/route-e2e-tests
git add src/routes/analytics.test.ts src/routes/health.test.ts src/routes/slackEvents.test.ts src/routes/channels.test.ts tests/e2e/fullFlow.test.ts
git commit -m "test: Add route and end-to-end tests"

echo "=== All branches created ==="
git branch
echo "=== Final log ==="
git log --oneline --all --graph | head -30
