# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aida AI is an MCP (Model Context Protocol) platform that lets users ask natural-language questions about Isprava's, Chapter's or  Lohono Stays' production data via a chat UI. Claude answers questions using MCP tools that query PostgreSQL.

**Four-tier architecture:**
- **MCP Server** (`:3000`) — Express SSE server exposing database tools via MCP protocol. Uses a modular plugin system, circuit-breaker-protected DB pool, Redis caching, and ACL-based access control.
- **MCP Client** (`:3001`) — Express REST API that orchestrates Claude's agentic loop. Supports SSE streaming, rate limiting, circuit breakers, and auto-reconnecting MCP bridge. Manages sessions/messages in MongoDB with windowed history (50 messages).
- **Chat Client** (`:8080`) — React SPA (Vite + Tailwind) served via nginx. Real-time streaming chat interface.
- **Redis** (`:6379`) — Shared cache for user ACLs, tool lists, and query results. Optional (falls back to in-memory).

## Build & Run Commands

```bash
# Install dependencies
npm install
npm --prefix lohono-chat-client install

# Build TypeScript (server + client)
npm run build          # tsc → dist/

# Development (hot-reload via tsx)
npm run dev            # MCP Server stdio mode
npm run dev:sse        # MCP Server SSE mode (port 3000)
npm run dev:client     # MCP Client API (port 3001)
npm run dev:chat       # Chat Client Vite dev server

# Production
npm start              # MCP Server stdio
npm run start:sse      # MCP Server SSE
npm run start:client   # MCP Client API

# Docker (preferred for full stack)
make up-d              # Start all services detached
make down              # Stop all
make deploy            # Production deploy
make deploy-all        # Deploy + observability (SigNoz)

# Individual services via Docker
make mcp-server        # PostgreSQL + MCP Server
make mcp-client        # + MongoDB + Client
make chat-client       # + Chat frontend

# Database
make db-shell          # psql into Postgres
make mongo-shell       # mongosh into MongoDB
make db-backup         # Dump to db/<timestamp>.sql.gz
make db-restore DUMP=db/<file>.sql.gz

# Catalog generation
npx tsx database/scripts/catalog-tables-direct.ts
```

Tests use Vitest (`npm test` runs all tests, `npm run test:watch` for watch mode). Test files are in `lohono-mcp-server/src/__tests__/` and `lohono-mcp-client/src/__tests__/`.

## Code Layout

```
lohono-mcp-server/src/     # MCP Server — the core
  index.ts                 # Stdio transport entrypoint
  index-sse.ts             # SSE transport entrypoint (Express)
  tools.ts                 # Tool facade (re-exports from tools/)
  tools/                   # Modular tool plugin system
    registry.ts            # Plugin registration, dispatch, ACL enforcement
    types.ts               # ToolPlugin, ToolDefinition, ToolResult interfaces
    sales-funnel.plugin.ts # Sales funnel plugins (5 tools, Redis-cached)
  acl.ts                   # ACL barrel export (re-exports from acl/)
  acl/                     # Modular ACL subsystem
    types.ts               # AclConfig, AclCheckResult interfaces
    config.ts              # YAML config loader
    email-resolver.ts      # User email resolution (3-source priority)
    evaluator.ts           # Access check and tool filtering logic
    user-cache.ts          # Redis-backed user ACL cache (5min TTL)
  db/                      # Database layer
    pool.ts                # PG pool + circuit breaker + executeReadOnlyQuery()
  database-catalog.ts      # Reads pre-built JSON catalogs from database/schema/
  sales-funnel-builder.ts  # Parameterized sales funnel SQL builders
  schema-rules.ts          # Sales funnel YAML rules engine
  query-analyzer.ts        # Regex-based SQL structural analysis
  rule-generator.ts        # Generates YAML rules from SQL queries
  redash-client.ts         # Fetches SQL queries from Redash API
  time-range/              # Time range parsing utilities
  nlq-resolver/            # Natural language query intent resolution

lohono-mcp-client/src/     # MCP Client — Claude orchestration layer
  index.ts                 # Entrypoint: connects MongoDB, PG, MCP, starts Express
  server.ts                # Express routes + rate limiting + SSE streaming endpoint
  agent.ts                 # Claude agentic loop + chatStream() async generator
  mcp-bridge.ts            # Multi-server SSE client + auto-reconnection + circuit breakers
  db.ts                    # MongoDB CRUD with windowed message retrieval
  auth.ts                  # Google OAuth + sliding-window session TTL (24h)

lohono-chat-client/        # React SPA (separate package.json, Vite build)
  src/App.tsx, components/, context/, pages/

shared/observability/src/  # OpenTelemetry + Winston logging (used by both server and client)
  tracing.ts               # OTel SDK bootstrap — MUST be first import in entrypoints
  logger.ts, middleware.ts, spans.ts, sanitize.ts

shared/redis/src/          # Redis cache abstraction
  index.ts                 # RedisCache<T> class with in-memory fallback

shared/circuit-breaker/src/ # Circuit breaker pattern implementation
  index.ts                 # CircuitBreaker class (closed → open → half-open)

database/                  # Static catalog data and scripts
  schema/                  # database-catalog.json, foreign-keys-catalog.json, acl.yml, query templates
  scripts/                 # Catalog generation scripts
```

## Key Architecture Patterns

**Tool plugin system:** Tools use a modular plugin architecture in `tools/`. Each plugin bundles a `ToolDefinition` and handler function. Register plugins via `registerPlugins()` in `tools/registry.ts`. The facade in `tools.ts` re-exports for backward compatibility. To add a new tool: create a plugin file, export it, and register in `tools.ts`.

**Read-only enforcement:** Every SQL query goes through `executeReadOnlyQuery()` in `db/pool.ts` which wraps queries in `BEGIN TRANSACTION READ ONLY` with a 30-second timeout. The PG pool is protected by a circuit breaker (5 failures → 30s cooldown).

**ACL system:** Tool access is controlled by `database/schema/acl.yml`, implemented in `acl/` modules. User ACLs come from the `staffs.acl_array` column in PostgreSQL, cached in Redis (5-minute TTL, in-memory fallback). Tools can be `public_tools`, `disabled_tools`, or require specific ACLs via `tool_acls`.

**Database catalog:** Schema intelligence comes from pre-built JSON files in `database/schema/` (loaded once and cached in memory), not live `information_schema` queries. The catalog tools (`get_table_schema`, `search_tables`, etc.) read from these files.

**Sales funnel tool:** The `get_sales_funnel` tool uses parameterized SQL with complex business logic (IST timezone offsets, slug exclusions, UNION of multiple sources). Query results are cached in Redis (60s TTL). This is the canonical way to query funnel metrics.

**Agentic loop:** `lohono-mcp-client/src/agent.ts` runs Claude in a loop (max 20 rounds) with windowed message history (last 50 messages). Two modes: `chat()` for batch responses, `chatStream()` for SSE streaming with real-time text deltas. Claude API calls are protected by a circuit breaker (3 failures → 60s cooldown).

**SSE streaming:** `chatStream()` is an async generator yielding `StreamEvent` objects (`text_delta`, `tool_start`, `tool_end`, `done`, `error`). The streaming endpoint is `GET /api/sessions/:id/messages/stream`.

**MCP bridge resilience:** `mcp-bridge.ts` supports auto-reconnection with exponential backoff (1s→60s, max 10 attempts) and per-server circuit breakers (5 failures → 30s cooldown). Tool lists are cached in Redis.

**Rate limiting:** Express endpoints are rate-limited — 60 req/min for general API, 20 req/min for chat (keyed by user email or IP).

**Session TTL:** Auth sessions have a 24-hour sliding-window TTL. MongoDB TTL index auto-deletes expired sessions.

**OTel instrumentation:** `shared/observability/src/tracing.ts` must be the **first import** in both entrypoints. All spans and structured logs include `trace_id` and `span_id` for correlation in SigNoz.

**Session email resolution:** User identity flows through three sources (priority order): `_meta.user_email` in MCP request params > `X-User-Email` HTTP header > `MCP_USER_EMAIL` env var.

## Configuration

All config is via environment variables (see `.env.example`). Key ones:
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — PostgreSQL connection
- `ANTHROPIC_API_KEY` — Claude API key (required)
- `CLAUDE_MODEL` — defaults to `claude-sonnet-4-5-20250929`
- `MCP_SSE_URL` — MCP Server URL for the client (default: `http://localhost:3000`)
- `MONGODB_URI`, `MONGODB_DB_NAME` — MongoDB for sessions
- `REDIS_URL` — Redis connection URL (optional, falls back to in-memory caching)
- `ACL_CONFIG_PATH` — path to `acl.yml`
- `DATABASE_DIR` — path to `database/` directory containing catalog JSON files
- `SALES_FUNNEL_RULES_PATH` — path to sales funnel YAML rules
- `REDASH_URL`, `REDASH_API_KEY` — optional Redash integration

## TypeScript

- ESM (`"type": "module"` in package.json) with Node16 module resolution
- All imports use `.js` extensions (required for ESM)
- Strict mode enabled
- Target: ES2022
- Tests (`**/__tests__/**`, `**/*.test.ts`) are excluded from `tsc` compilation
