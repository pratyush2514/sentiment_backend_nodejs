# Stage 1: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN pnpm run build

# Stage 2: Production
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'if [ "${RUNTIME_ROLE:-all}" = "web" ] || [ "${RUNTIME_ROLE:-all}" = "all" ]; then wget --no-verbose --tries=1 --spider http://localhost:3000/health/ready || exit 1; else exit 0; fi'
CMD ["node", "dist/index.js"]
