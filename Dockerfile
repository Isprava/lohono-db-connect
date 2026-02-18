# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY tsconfig.json ./
COPY lohono-mcp-server/src/ ./lohono-mcp-server/src/
COPY shared/ ./shared/
RUN npm run build

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy database config and schema
COPY database/ ./database/

# Environment defaults
ENV NODE_ENV=production
ENV SALES_FUNNEL_RULES_PATH=/app/database/schema/sales_funnel_rules_v2.yml
ENV PORT=3000

# Expose SSE port
EXPOSE 3000

# Health check against the SSE server's /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Default: run SSE server (can be overridden in docker-compose)
CMD ["node", "dist/lohono-mcp-server/src/index-sse.js"]
