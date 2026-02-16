# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aida AI is an MCP (Model Context Protocol) platform that lets users ask natural-language questions about Isprava's, Chapter's or  Lohono Stays' production data via a chat UI. Claude answers questions using MCP tools that query PostgreSQL.

**Three-tier architecture:**
- **MCP Server** (`:3000`) — Express SSE server exposing database tools via MCP protocol. Enforces read-only queries, ACL-based access control, and serves pre-built database catalog data.
- **MCP Client** (`:3001`) — Express REST API that orchestrates Claude's agentic loop. Connects to MCP Server via SSE, manages sessions/messages in MongoDB, handles Google OAuth auth.
- **Chat Client** (`:8080`) — React SPA (Vite + Tailwind) served via nginx. Provides the user-facing chat interface.

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

There are no tests configured (`npm test` exits with error). The `lohono-mcp-server/src/**/__tests__/` directories contain test files but no test runner is set up.

## Code Layout

```
lohono-mcp-server/src/     # MCP Server — the core
  index.ts                 # Stdio transport entrypoint
  index-sse.ts             # SSE transport entrypoint (Express)
  tools.ts                 # ALL MCP tool definitions + handlers + DB pool
  acl.ts                   # YAML-based ACL enforcement (per-tool, per-user)
  database-catalog.ts      # Reads pre-built JSON catalogs from database/schema/
  schema-rules.ts          # Sales funnel YAML rules engine (intent classification, templates)
  query-analyzer.ts        # Regex-based SQL structural analysis
  rule-generator.ts        # Generates YAML rules from SQL queries
  redash-client.ts         # Fetches SQL queries from Redash API
  time-range/              # Time range parsing utilities
  nlq-resolver/            # Natural language query intent resolution

lohono-mcp-client/src/     # MCP Client — Claude orchestration layer
  index.ts                 # Entrypoint: connects MongoDB, PG, MCP, starts Express
  server.ts                # Express routes (auth, sessions, chat, health)
  agent.ts                 # Claude agentic loop (up to 20 tool rounds)
  mcp-bridge.ts            # SSE client connecting to MCP Server
  db.ts                    # MongoDB session/message CRUD
  auth.ts                  # Google OAuth + staff verification via PG staffs table

lohono-chat-client/        # React SPA (separate package.json, Vite build)
  src/App.tsx, components/, context/, pages/

shared/observability/src/  # OpenTelemetry + Winston logging (used by both server and client)
  tracing.ts               # OTel SDK bootstrap — MUST be first import in entrypoints
  logger.ts, middleware.ts, spans.ts, sanitize.ts

database/                  # Static catalog data and scripts
  schema/                  # database-catalog.json, foreign-keys-catalog.json, acl.yml, query templates
  scripts/                 # Catalog generation scripts
```

## Key Architecture Patterns

**Tool registration:** All MCP tools are defined in `lohono-mcp-server/src/tools.ts` — both entrypoints (`index.ts`, `index-sse.ts`) are thin wrappers that register the same `toolDefinitions` and `handleToolCall`. To add a new tool: define a Zod schema, add to `toolDefinitions` array, add handler in `handleToolCall()`.

**Read-only enforcement:** Every SQL query goes through `executeReadOnlyQuery()` which wraps queries in `BEGIN TRANSACTION READ ONLY` with a 30-second timeout.

**ACL system:** Tool access is controlled by `database/schema/acl.yml`. User ACLs come from the `staffs.acl_array` column in PostgreSQL, cached for 5 minutes. Tools can be `public_tools`, `disabled_tools`, or require specific ACLs via `tool_acls`.

**Database catalog:** Schema intelligence comes from pre-built JSON files in `database/schema/` (loaded once and cached in memory), not live `information_schema` queries. The catalog tools (`get_table_schema`, `search_tables`, etc.) read from these files.

**Sales funnel tool:** The `get_sales_funnel` tool contains a hardcoded SQL query with complex business logic (IST timezone offsets, slug exclusions, UNION of multiple sources, stage history joins). This is the canonical way to query funnel metrics — the generic `query` tool has been removed/disabled.

**Agentic loop:** `lohono-mcp-client/src/agent.ts` runs Claude in a loop (max 20 rounds). Each round: send messages to Claude API, if Claude responds with `tool_use` blocks, execute them via the MCP bridge, persist results to MongoDB, and loop back.

**OTel instrumentation:** `shared/observability/src/tracing.ts` must be the **first import** in both entrypoints. All spans and structured logs include `trace_id` and `span_id` for correlation in SigNoz.

**Session email resolution:** User identity flows through three sources (priority order): `_meta.user_email` in MCP request params > `X-User-Email` HTTP header > `MCP_USER_EMAIL` env var.

## Configuration

All config is via environment variables (see `.env.example`). Key ones:
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — PostgreSQL connection
- `ANTHROPIC_API_KEY` — Claude API key (required)
- `CLAUDE_MODEL` — defaults to `claude-sonnet-4-5-20250929`
- `MCP_SSE_URL` — MCP Server URL for the client (default: `http://localhost:3000`)
- `MONGODB_URI`, `MONGODB_DB_NAME` — MongoDB for sessions
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
