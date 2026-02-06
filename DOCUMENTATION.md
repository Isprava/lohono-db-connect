# Lohono DB Context — MCP Server Implementation Documentation

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [Configuration](#5-configuration)
6. [Source Code Walkthrough](#6-source-code-walkthrough)
7. [MCP Tools Reference](#7-mcp-tools-reference)
8. [Schema Intelligence Engine](#8-schema-intelligence-engine)
9. [Sales Funnel Rules (YAML)](#9-sales-funnel-rules-yaml)
10. [Security Model](#10-security-model)
11. [Transport Modes](#11-transport-modes)
12. [Claude Desktop Integration](#12-claude-desktop-integration)
13. [Deployment & Operations](#13-deployment--operations)
14. [Data Flow Diagrams](#14-data-flow-diagrams)
15. [Error Handling](#15-error-handling)
16. [Example Prompts & Workflows](#16-example-prompts--workflows)
17. [Adding a New MCP Tool](#17-adding-a-new-mcp-tool)
18. [Adding New Schema Intelligence Rules](#18-adding-new-schema-intelligence-rules)
19. [Docker Deployment](#19-docker-deployment)

---

## 1. Project Overview

**lohono-db-context** is a Model Context Protocol (MCP) server that enables LLM clients (such as Claude Desktop) to:

- Execute **read-only SQL queries** against the `lohono_api_production` PostgreSQL database.
- Introspect the database schema (list tables, describe columns, list schemas).
- Access **sales funnel business intelligence rules** loaded from a YAML configuration file.
- **Classify natural-language questions** into predefined query patterns and retrieve all applicable business rules, date filters, and validation checks needed to generate correct SQL.

The server acts as a bridge between an LLM and the production database, ensuring that:
- All queries are strictly read-only (enforced at the transaction level).
- The LLM has access to complex business rules that govern how sales funnel queries must be constructed.
- Input validation is enforced via Zod schemas on every tool call.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Desktop / LLM Client           │
└──────────────┬──────────────────────────┬───────────────┘
               │ stdio (JSON-RPC)         │ SSE (HTTP)
               ▼                          ▼
┌──────────────────────┐   ┌──────────────────────────────┐
│   index.ts (stdio)   │   │   index-sse.ts (Express+SSE) │
│   StdioServerTransport│  │   SSEServerTransport          │
└──────────┬───────────┘   └──────────────┬───────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────────────────────────────────────┐
│                     tools.ts (shared)                    │
│  ┌──────────────────┐  ┌────────────────────────────┐   │
│  │  Database Tools   │  │  Schema Intelligence Tools  │  │
│  │  - query          │  │  - get_sales_funnel_context │  │
│  │  - list_tables    │  │  - classify_sales_intent    │  │
│  │  - describe_table │  │  - get_query_template       │  │
│  │  - list_schemas   │  │  - list_query_patterns      │  │
│  └────────┬─────────┘  └──────────────┬──────────────┘  │
│           │                            │                 │
│           ▼                            ▼                 │
│  ┌──────────────────┐  ┌────────────────────────────┐   │
│  │   PostgreSQL      │  │   schema-rules.ts          │   │
│  │   (pg Pool)       │  │   (YAML loader + engine)   │   │
│  └──────────────────┘  └────────────────────────────┘   │
│                                        │                 │
│                                        ▼                 │
│                         ┌────────────────────────────┐   │
│                         │ sales_funnel_rules_v2.yml   │   │
│                         └────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Shared tools module (`tools.ts`):** All tool definitions and handlers live in a single shared module. Both transport entry points (`index.ts` and `index-sse.ts`) are thin wrappers that register the same handlers.
- **Read-only enforcement:** Every SQL query is wrapped in `BEGIN TRANSACTION READ ONLY` ... `COMMIT`, preventing any data mutation even if the LLM generates a `DELETE` or `UPDATE`.
- **Lazy YAML loading:** The rules file is read from disk once on first access and cached in memory for the lifetime of the process.

---

## 3. Technology Stack

| Component | Technology | Version | Purpose |
|---|---|---|---|
| Runtime | Node.js | ≥18 | JavaScript execution |
| Language | TypeScript | ^5.9.3 | Type-safe development |
| MCP SDK | @modelcontextprotocol/sdk | ^1.25.3 | MCP protocol implementation |
| Database driver | pg (node-postgres) | ^8.18.0 | PostgreSQL connection pooling & queries |
| Validation | Zod | ^4.3.6 | Runtime input validation for tool arguments |
| YAML parsing | js-yaml | ^4.1.1 | Load sales funnel rules from YAML |
| HTTP server | Express | ^5.2.1 | SSE transport endpoint |
| CORS | cors | ^2.8.6 | Cross-origin support for SSE mode |
| Dev runner | tsx | ^4.21.0 | TypeScript execution without build step |

---

## 4. Project Structure

```
lohono-db-context/
├── src/
│   ├── index.ts            # Entry point — stdio transport
│   ├── index-sse.ts        # Entry point — SSE/HTTP transport
│   ├── tools.ts            # Shared tool definitions + handlers + DB pool
│   └── schema-rules.ts     # YAML loader, intent classifier, template engine
├── dist/                   # Compiled JavaScript output (gitignored)
├── package.json            # Dependencies, scripts, metadata
├── tsconfig.json           # TypeScript compiler options
├── .gitignore              # Ignores node_modules, dist, .env, logs
├── PROMPTS.md              # Example prompts for LLM clients
├── DOCUMENTATION.md        # This file
└── README.md               # Quick-start README
```

### File Responsibilities

**`src/index.ts`** (47 lines)
- Creates an MCP `Server` instance with `StdioServerTransport`.
- Registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers that delegate to `tools.ts`.
- Handles `SIGINT` for graceful DB pool shutdown.

**`src/index-sse.ts`** (81 lines)
- Creates an Express app with CORS and JSON body parsing.
- Creates an MCP `Server` instance with `SSEServerTransport`.
- Exposes three HTTP endpoints: `GET /sse`, `POST /messages`, `GET /health`.
- The `/health` endpoint performs a live `SELECT 1` against the database and returns connection status.

**`src/tools.ts`** (324 lines)
- Exports `pool` (the `pg.Pool` instance), `toolDefinitions` (array of 8 MCP tool schemas), and `handleToolCall()` (the dispatch function).
- Contains all Zod validation schemas.
- Implements the `executeReadOnlyQuery()` helper that wraps every query in a read-only transaction.

**`src/schema-rules.ts`** (388 lines)
- Defines TypeScript interfaces for the YAML structure (`SalesFunnelRules`, `QueryPattern`, `CoreRule`, etc.).
- Exports four functions: `loadRules()`, `getFullContext()`, `classifyIntent()`, `getQueryTemplate()`, and `listQueryPatterns()`.
- Contains internal helpers for keyword matching, rule filtering, and validation check aggregation.

---

## 5. Configuration

### 5.1 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5433` | PostgreSQL port |
| `DB_USER` | `lohono_api` | PostgreSQL user |
| `DB_NAME` | `lohono_api_production` | PostgreSQL database name |
| `DB_PASSWORD` | `""` (empty) | PostgreSQL password |
| `SALES_FUNNEL_RULES_PATH` | `/home/isprava/Downloads/sales_funnel_rules_v2.yml` | Absolute path to the YAML rules file |
| `PORT` | `3000` | HTTP listen port (SSE mode only) |

### 5.2 NPM Scripts

| Script | Command | Description |
|---|---|---|
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm run dev` | `tsx src/index.ts` | Run stdio server in dev mode (no build needed) |
| `npm run dev:sse` | `tsx src/index-sse.ts` | Run SSE server in dev mode |
| `npm start` | `node dist/index.js` | Run compiled stdio server |
| `npm run start:sse` | `node dist/index-sse.js` | Run compiled SSE server |

### 5.3 TypeScript Configuration

Key `tsconfig.json` settings:
- **Target:** ES2022 (modern async/await, top-level await support)
- **Module:** Node16 (ESM with `.js` extensions in imports)
- **Strict:** `true` (full type checking)
- **Declarations:** `true` (generates `.d.ts` files in `dist/`)
- **Source maps:** `true` (for debugging)

---

## 6. Source Code Walkthrough

### 6.1 Database Connection Pool (`tools.ts:14-20`)

```typescript
export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
});
```

- Uses `pg.Pool` for connection pooling (default pool size: 10 connections).
- The pool is exported and shared by both entry points.
- On `SIGINT`, both entry points call `pool.end()` to close all connections gracefully.

### 6.2 Read-Only Query Execution (`tools.ts:48-61`)

```typescript
async function executeReadOnlyQuery(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

**How it works:**
1. Acquires a client from the pool.
2. Opens a `READ ONLY` transaction — PostgreSQL will reject any `INSERT`, `UPDATE`, `DELETE`, or DDL statement.
3. Executes the parameterized query.
4. Commits (or rolls back on error).
5. Always releases the client back to the pool in the `finally` block.

This is the **only path** through which SQL reaches the database, guaranteeing read-only access at the database engine level.

### 6.3 Input Validation (`tools.ts:24-44`)

Five Zod schemas validate all tool inputs:

```typescript
const QueryInputSchema = z.object({
  sql: z.string().min(1, "SQL query cannot be empty"),
  params: z.array(z.unknown()).optional(),
});

const DescribeTableInputSchema = z.object({
  table_name: z.string().min(1, "Table name cannot be empty"),
  schema: z.string().optional().default("public"),
});

const ListTablesInputSchema = z.object({
  schema: z.string().optional().default("public"),
});

const ClassifyIntentInputSchema = z.object({
  question: z.string().min(1, "Question cannot be empty"),
});

const GetQueryTemplateInputSchema = z.object({
  pattern_name: z.string().min(1, "Pattern name cannot be empty"),
});
```

If validation fails, the error is caught in the `handleToolCall()` function and returned as an `isError: true` MCP response with a human-readable message.

### 6.4 YAML Rules Loader (`schema-rules.ts:100-111`)

```typescript
const RULES_PATH =
  process.env.SALES_FUNNEL_RULES_PATH ||
  "/home/isprava/Downloads/sales_funnel_rules_v2.yml";

let _rules: SalesFunnelRules | null = null;

export function loadRules(): SalesFunnelRules {
  if (_rules) return _rules;
  const raw = fs.readFileSync(RULES_PATH, "utf-8");
  _rules = yaml.load(raw) as SalesFunnelRules;
  return _rules;
}
```

- Reads the YAML file synchronously on first call.
- Caches the parsed result in module-level `_rules` variable.
- Subsequent calls return the cached object instantly (no disk I/O).
- The path is configurable via `SALES_FUNNEL_RULES_PATH` env var.

### 6.5 Intent Classification Engine (`schema-rules.ts:150-243`)

The `classifyIntent(question)` function implements a multi-step keyword matching pipeline:

**Step 1 — Keyword Extraction:**
The user's question (lowercased) is matched against four keyword groups defined in the YAML:
- `time_period_keywords` — e.g., "MTD", "last year", "last 12 months"
- `metric_keywords` — e.g., "leads", "meetings", "conversion time"
- `granularity_keywords` — e.g., "total", "by source", "details"
- `filter_keywords` — e.g., "open", "closed", "aging", "by region"

Each group can match at most once (first match wins per group).

**Step 2 — Category & Pattern Resolution:**
Matched keywords map to:
- `suggests_categories` → broad query categories (e.g., `mtd_aggregate`, `source_breakdown`)
- `requires_pattern` → specific query patterns (e.g., `mtd_funnel_current`)
- `maps_to_filter` → date filter name (e.g., `mtd_current_progressive`)

**Step 3 — Pattern Matching:**
All 9 query patterns are evaluated. A pattern matches if:
- It is in `requiredPatterns` (from keyword mapping), OR
- Its category is in `suggestedCategories`, OR
- Any of its `user_intent_keywords` appear in the question.

**Step 4 — Rule Assembly:**
For each matched pattern, the function gathers:
- All `core_rules` that apply to the pattern's category
- The applicable date filter (from time period keyword or pattern default)
- Universal + category-specific validation checks

**Step 5 — Fallback:**
If no pattern matches, falls back to `mtd_funnel_current` (the most common query).

**Return value structure:**
```json
{
  "question": "...",
  "matched_keywords": {
    "time_period": [{ "group": "mtd_current", "keyword": "this month" }],
    "metrics": [{ "group": "funnel", "keyword": "leads" }],
    "granularity": [...],
    "filters": [...]
  },
  "suggested_date_filter": "mtd_current_progressive",
  "matching_patterns": [
    {
      "pattern_name": "mtd_funnel_current",
      "category": "mtd_aggregate",
      "description": "...",
      "applicable_rules": { ... },
      "date_filter": { ... },
      "validation_checks": [ ... ]
    }
  ],
  "source_mapping_sql": "CASE WHEN source = 'agent' THEN 'Agent' ...",
  "anti_patterns": [ ... ]
}
```

### 6.6 Query Template Engine (`schema-rules.ts:249-303`)

The `getQueryTemplate(patternName)` function returns a comprehensive rule package for a specific pattern:

1. Looks up the pattern by name from `query_patterns`.
2. Collects applicable `core_rules` (universal + category-specific).
3. Resolves the `date_filter` (SQL templates for date range and progressive filter).
4. Resolves `special_logic` — for patterns that reference `special_patterns` (e.g., `source_daily_breakdown` uses date series generation, `aging_reports.prospect_aging` uses aging calculation logic).
5. Includes all `funnel_stages` definitions with their timestamp columns and mandatory conditions.
6. Filters `metrics` to only those relevant to the pattern's category.
7. Includes `source_mapping` CASE statement.
8. Includes `status_logic` (open/closed definitions).
9. Includes `validation_checks` and `anti_patterns`.

---

## 7. MCP Tools Reference

### 7.1 Database Tools

#### `query`
Execute a read-only SQL query against the database.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `sql` | string | Yes | SQL query to execute |
| `params` | array | No | Parameterized values (`$1`, `$2`, ...) |

**Output:** `{ rowCount: number, rows: object[] }`

**Example call:**
```json
{
  "name": "query",
  "arguments": {
    "sql": "SELECT COUNT(*) FROM development_opportunities WHERE status != 'closed'",
    "params": []
  }
}
```

---

#### `list_tables`
List all tables in a database schema.

**Input:**
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `schema` | string | No | `"public"` | Schema name |

**Output:** Array of `{ table_name, table_type }`

---

#### `describe_table`
Get column definitions, types, nullability, defaults, and constraints.

**Input:**
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `table_name` | string | Yes | — | Table to describe |
| `schema` | string | No | `"public"` | Schema name |

**Output:** Array of `{ column_name, data_type, character_maximum_length, is_nullable, column_default, constraint_type }`

**SQL used internally:**
```sql
SELECT
  c.column_name,
  c.data_type,
  c.character_maximum_length,
  c.is_nullable,
  c.column_default,
  tc.constraint_type
FROM information_schema.columns c
LEFT JOIN information_schema.key_column_usage kcu
  ON c.table_schema = kcu.table_schema
  AND c.table_name = kcu.table_name
  AND c.column_name = kcu.column_name
LEFT JOIN information_schema.table_constraints tc
  ON kcu.constraint_name = tc.constraint_name
  AND kcu.table_schema = tc.table_schema
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
```

---

#### `list_schemas`
List all user-defined schemas (excludes `pg_catalog`, `information_schema`, `pg_toast`).

**Input:** None

**Output:** Array of `{ schema_name }`

---

### 7.2 Schema Intelligence Tools

#### `get_sales_funnel_context`
Returns the **complete business rules context**. An LLM should call this first before generating any sales funnel query.

**Input:** None

**Output:** A JSON object containing:
- `section` — Section metadata (name: "sales_funnel", vertical: "development")
- `core_rules` — All 4 mandatory rules (timezone, slug exclusions, distinct counting, DnB exclusion)
- `date_filters` — All 4 date filter templates with SQL patterns
- `funnel_stages` — Lead, Prospect, Account, Sale definitions with timestamp columns and mandatory conditions
- `metrics` — Meetings, Viewings, L2P/P2A/A2S duration calculations
- `source_mapping` — Source CASE statement and category definitions
- `status_logic` — Open/closed definitions, closed reason extraction, stage history joins
- `anti_patterns` — 9 anti-patterns documenting what NOT to do
- `validation_checklist` — Universal + category-specific validation checks
- `tables` — List of all database tables involved

---

#### `classify_sales_intent`
Classifies a natural-language question and returns matching query patterns with all applicable rules.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `question` | string | Yes | The user's question about sales/funnel data |

**Output:** See [Section 6.5](#65-intent-classification-engine-schema-rulests150-243) for the full return structure.

---

#### `get_query_template`
Returns the complete rule package for a named query pattern.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern_name` | string | Yes | One of the 9 pattern names |

**Available pattern names:**
- `mtd_funnel_current`
- `mtd_funnel_last_year`
- `source_daily_breakdown`
- `open_funnel_count`
- `mtd_lead_details`
- `prospect_aging`
- `account_aging`
- `historical_funnel_details`
- `regional_closed_analysis`

**Output:** See [Section 6.6](#66-query-template-engine-schema-rulests249-303) for the full return structure.

---

#### `list_query_patterns`
Lists all available query patterns with descriptions and intent keywords.

**Input:** None

**Output:** Array of:
```json
{
  "name": "mtd_funnel_current",
  "category": "mtd_aggregate",
  "description": "Current month-to-date funnel metrics with progressive day filter",
  "user_intent_keywords": ["MTD funnel", "month to date metrics", "current month funnel", "this month performance"]
}
```

---

## 8. Schema Intelligence Engine

The schema intelligence engine is the core differentiator of this MCP server. It transforms a static YAML configuration file into dynamic, context-aware tool responses.

### 8.1 Why It Exists

Sales funnel SQL queries have complex, interacting business rules:
- Some queries must exclude certain slugs, others must not.
- The DnB source exclusion applies only to the "leads" metric, not to prospects/accounts/sales.
- Date filters differ by query pattern (MTD vs trailing 12 months vs since FY 2022).
- Progressive day filters apply to some patterns but not others.
- Timezone conversion to IST is mandatory everywhere but uses different formats in different contexts.

Without the schema intelligence engine, an LLM would need to memorize all of these rules. With it, the LLM simply calls `classify_sales_intent()` or `get_query_template()` and receives all applicable rules in a structured format.

### 8.2 Rule Resolution Logic

Rules are resolved via a category-based system:

1. Each query pattern belongs to exactly one **category** (e.g., `mtd_aggregate`, `aging_reports`).
2. Each core rule specifies `applies_to` — either `"ALL queries"` or an array of category names.
3. When a pattern is requested, `getApplicableRules()` filters core rules to those that apply to the pattern's category.
4. Validation checks work the same way — universal checks always apply, category-specific checks apply only to matching categories.

### 8.3 Type Safety

The YAML is loaded as `SalesFunnelRules` — a TypeScript interface with 14 top-level fields. Key sub-types include:

- `CoreRule` — has `description`, `sql_pattern`, `applies_to`, `mandatory`
- `DateFilter` — has `date_filter_sql`, `progressive_day_filter`, `progressive_filter_sql`
- `QueryPattern` — has `category`, `user_intent_keywords`, `applies_date_filter`, `structure`
- `AntiPattern` — has `pattern`, `why`, `wrong`, `correct`
- `ValidationCheck` — has `id`, `rule`, `check`

---

## 9. Sales Funnel Rules (YAML)

The YAML file (`sales_funnel_rules_v2.yml`) is the single source of truth for all business rules. It contains 12 top-level sections:

### 9.1 Section Metadata
Identifies this as the "sales_funnel" section for the "development" vertical.

### 9.2 Query Categories (6 categories)
Groups query patterns into logical categories:
- `mtd_aggregate` — MTD funnel metrics (patterns: `mtd_funnel_current`, `mtd_funnel_last_year`)
- `source_breakdown` — Source-wise metrics (patterns: `source_daily_breakdown`)
- `open_count` — Active pipeline counts (patterns: `open_funnel_count`)
- `detail_listings` — Row-level reports (patterns: `mtd_lead_details`)
- `aging_reports` — Stage aging analysis (patterns: `prospect_aging`, `account_aging`)
- `historical_analysis` — 12-month history (patterns: `historical_funnel_details`, `regional_closed_analysis`)

### 9.3 Core Rules (4 mandatory rules)

| Rule | Description | Applies To |
|---|---|---|
| `timezone_conversion` | Convert all timestamps to IST via `+ interval '330 minutes'` | ALL queries |
| `slug_exclusions` | Exclude slugs `569657C6`, `5EB1A14A`, `075E54DF` from `development_opportunities` (never from `enquiries`) | mtd_aggregate, source_breakdown, detail_listings, historical_analysis (NOT aging_reports) |
| `distinct_counting` | Always use `COUNT(DISTINCT(development_opportunities.slug))` | ALL queries with opportunity counts |
| `source_exclusion_dnb` | Exclude `source != 'DnB'` for **leads metric only** | mtd_aggregate, source_breakdown, historical_analysis |

### 9.4 Date Filters (4 filter templates)

| Filter | SQL Date Range | Progressive Day Filter | Used By |
|---|---|---|---|
| `mtd_current_progressive` | Current month boundaries with IST | Yes — `date_part('day', ...) <= date_part('day', now())` | mtd_aggregate, source_breakdown, open_count, detail_listings |
| `mtd_last_year_progressive` | Same month last year boundaries | Yes — same logic with `now() - interval '1 year'` | mtd_aggregate (last year only) |
| `trailing_12_months` | Last 12 months from current month | No | historical_analysis |
| `since_fy_2022` | From `2022-04-01` onwards | No | aging_reports |

### 9.5 Funnel Stages (4 stages)

| Stage | Timestamp Column | Table | Special Notes |
|---|---|---|---|
| Lead | `enquired_at` (opportunities) + `created_at` (enquiries) | Both tables, combined via addition | Two-source combination: `opportunities_count + enquiries_count` |
| Prospect | `lead_completed_at` | `development_opportunities` | No DnB exclusion |
| Account | `prospect_completed_at` | `development_opportunities` | No DnB exclusion |
| Sale | `maal_laao_at` | `development_opportunities` | No DnB exclusion |

### 9.6 Metrics (5 metrics)

| Metric | Calculation | Notes |
|---|---|---|
| Meetings | `COUNT(DISTINCT slug)` via tasks + activities + medium join | `medium.name = 'Meeting'` |
| Viewings | `COUNT(DISTINCT slug)` via tasks + activities + medium + staffs join | South region only, specific medium names |
| L2P Duration | `AVG(date(lead_completed_at) - date(enquired_at))` | Cast to int |
| P2A Duration | `AVG(date(prospect_completed_at) - date(lead_completed_at))` | Cast to int |
| A2S Duration | `AVG(date(maal_laao_at) - date(prospect_completed_at))` | Cast to int |

### 9.7 Source Mapping
Maps raw source values into 6 business categories via a SQL `CASE` statement:
- **Agent** — `agent`
- **Digital** — `direct_mailer`, `emailer`, `google`, `facebook`, `instagram`, `linkedin`, `youtube`, `signage`, `isprava`, `isprava.com`, `isprava.com_chatbot`, `direct_call`
- **Lohono** — `lohono.com`, `lohono`
- **Reference + Word of Mouth** — `reference`, `word_of_mouth`, `isprava_employee`, `chapter_employee`, `chapter_reference`, `homeowner_ref`
- **Repeat Client** — `repeat_client`
- **Other** — everything else (default)

### 9.8 Status Logic
Defines open/closed status conditions, closed reason extraction from JSONB, stage history joins, and maal_laao date extraction from tasks.

### 9.9 Anti-Patterns (9 rules)
Documents what NOT to do, including: don't use `BETWEEN` for dates, don't mix timezone formats, don't apply slug exclusions to enquiries, don't count tasks instead of distinct opportunities, don't exclude DnB from all stages, don't apply slug exclusions to aging reports, don't use `closed_reason` directly (it's JSONB).

### 9.10 Validation Checklist
3 universal checks + category-specific checks for mtd_aggregate (5), source_breakdown (2), open_count (3), aging_reports (4), and historical_analysis (3).

### 9.11 Intent Classification
Keyword-to-pattern mapping system with 4 keyword dimensions (time_period, metric, granularity, filter) and a 6-step classification workflow.

### 9.12 Metadata
Lists all 9 dependent database tables:
`development_opportunities`, `enquiries`, `tasks`, `activities`, `medium`, `staffs`, `agents`, `stage_histories`, `stages`

---

## 10. Security Model

### 10.1 Read-Only Database Access
- Every query is wrapped in `BEGIN TRANSACTION READ ONLY`.
- PostgreSQL itself rejects any mutating statement within a read-only transaction.
- The database user (`lohono_api`) should ideally have only `SELECT` privileges.

### 10.2 Parameterized Queries
- The `query` tool supports `$1, $2, ...` parameterized queries via the `params` array.
- This prevents SQL injection when user-supplied values are passed through the LLM.

### 10.3 Input Validation
- All tool inputs are validated via Zod schemas before processing.
- Invalid inputs return `isError: true` responses with descriptive messages.

### 10.4 Password Handling
- The database password is read from the `DB_PASSWORD` environment variable.
- It is never hardcoded in source code (defaults to empty string for local passwordless connections).

---

## 11. Transport Modes

### 11.1 Stdio Transport (`index.ts`)

- Communication via standard input/output using JSON-RPC.
- Used by Claude Desktop (and other MCP clients) that spawn the server as a child process.
- No HTTP server, no network port.
- The process reads MCP requests from stdin and writes responses to stdout.
- Diagnostic messages go to stderr (e.g., `"MCP server running on stdio"`).

**When to use:** Claude Desktop integration, CLI tools, local development.

### 11.2 SSE Transport (`index-sse.ts`)

- Communication via Server-Sent Events over HTTP.
- Express server listens on port 3000 (configurable via `PORT`).
- Three endpoints:
  - `GET /sse` — Establishes SSE connection and creates `SSEServerTransport`.
  - `POST /messages` — Receives client messages.
  - `GET /health` — Returns `{ status: "ok", db: "connected" }` or `503` if DB is unreachable.
- CORS enabled for cross-origin access.

**When to use:** Web applications, remote clients, multi-client scenarios.

---

## 12. Claude Desktop Integration

### 12.1 Configuration

Create or edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lohono-db-context": {
      "command": "node",
      "args": ["/home/isprava/AILABS/MCP/lohono-db-context/dist/index.js"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "5433",
        "DB_USER": "lohono_api",
        "DB_NAME": "lohono_api_production",
        "DB_PASSWORD": "",
        "SALES_FUNNEL_RULES_PATH": "/home/isprava/Downloads/sales_funnel_rules_v2.yml"
      }
    }
  }
}
```

### 12.2 How Claude Desktop Uses It

1. On startup, Claude Desktop spawns `node dist/index.js` as a child process.
2. It calls `ListTools` and discovers all 8 tools.
3. When the user asks a sales funnel question, Claude:
   - Calls `classify_sales_intent` to identify the query pattern.
   - Calls `get_query_template` to get all business rules.
   - Generates SQL adhering to all mandatory rules.
   - Calls `query` to execute the SQL.
   - Formats and presents the results.

---

## 13. Deployment & Operations

### 13.1 Build & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run stdio mode
npm start

# Run SSE mode
npm run start:sse

# Development (no build step needed)
npm run dev        # stdio
npm run dev:sse    # SSE
```

### 13.2 Prerequisites

- Node.js ≥ 18
- PostgreSQL accessible at `localhost:5433` with database `lohono_api_production`
- The YAML rules file at the configured path

### 13.3 Health Check (SSE mode)

```bash
curl http://localhost:3000/health
# { "status": "ok", "server": "lohono-db-context", "db": "connected" }
```

### 13.4 Graceful Shutdown

Both modes handle `SIGINT` (Ctrl+C):
1. Close all PostgreSQL pool connections via `pool.end()`.
2. Exit with code 0.

---

## 14. Data Flow Diagrams

### 14.1 Query Execution Flow

```
User Question
      │
      ▼
Claude Desktop (LLM)
      │
      ├─── classify_sales_intent({ question }) ──► schema-rules.ts
      │         │                                    │
      │         ◄── matching patterns + rules ───────┘
      │
      ├─── get_query_template({ pattern_name }) ──► schema-rules.ts
      │         │                                    │
      │         ◄── full rule package ───────────────┘
      │
      │   [LLM generates SQL using rules]
      │
      ├─── query({ sql, params }) ──► tools.ts
      │         │                       │
      │         │              executeReadOnlyQuery()
      │         │                       │
      │         │              BEGIN TRANSACTION READ ONLY
      │         │              Execute SQL
      │         │              COMMIT
      │         │                       │
      │         ◄── { rowCount, rows } ─┘
      │
      ▼
Formatted response to user
```

### 14.2 Intent Classification Flow

```
question: "Show leads by source this month"
      │
      ▼
Lowercase: "show leads by source this month"
      │
      ├── time_period_keywords ──► match: "this month" → mtd_current
      ├── metric_keywords ──────► match: "leads" → suggests [mtd_aggregate, source_breakdown]
      ├── granularity_keywords ──► match: "by source" → suggests [source_breakdown]
      ├── filter_keywords ──────► no match
      │
      ▼
Suggested categories: { mtd_aggregate, source_breakdown }
Date filter: mtd_current_progressive
      │
      ▼
Match patterns by category:
  ✓ mtd_funnel_current (mtd_aggregate)
  ✓ mtd_funnel_last_year (mtd_aggregate)
  ✓ source_daily_breakdown (source_breakdown)
      │
      ▼
For each: attach applicable_rules + date_filter + validation_checks
      │
      ▼
Return { matching_patterns: [...], anti_patterns: [...] }
```

---

## 15. Error Handling

### 15.1 Zod Validation Errors

When tool input fails Zod validation:
```json
{
  "content": [{ "type": "text", "text": "Validation error: SQL query cannot be empty" }],
  "isError": true
}
```

### 15.2 Database Errors

When a SQL query fails (syntax error, permission denied, etc.):
```json
{
  "content": [{ "type": "text", "text": "Error: relation \"nonexistent_table\" does not exist" }],
  "isError": true
}
```

### 15.3 Unknown Tool

When an unregistered tool name is called:
```json
{
  "content": [{ "type": "text", "text": "Error: Unknown tool: foo" }],
  "isError": true
}
```

### 15.4 Unknown Query Pattern

When `get_query_template` is called with an invalid pattern name:
```json
{
  "content": [{ "type": "text", "text": "Unknown pattern: \"foo\". Use list_query_patterns to see available patterns." }],
  "isError": true
}
```

### 15.5 YAML File Missing

If the rules YAML file is not found at the configured path, `loadRules()` will throw a filesystem error, which is caught by the generic error handler and returned as an MCP error response.

---

## 16. Example Prompts & Workflows

### 16.1 MTD Funnel Overview

**User:** "Show me the MTD funnel numbers"

**LLM Workflow:**
1. `classify_sales_intent({ question: "Show me the MTD funnel numbers" })`
2. Gets `mtd_funnel_current` pattern with rules: timezone conversion, slug exclusions, distinct counting, DnB exclusion (leads only), progressive day filter
3. `get_query_template({ pattern_name: "mtd_funnel_current" })`
4. Builds CTE-based SQL with leads (opps + enquiries), prospects, accounts, sales, meetings, viewings, L2P/P2A/A2S durations
5. `query({ sql: "WITH leads AS (...), prospects AS (...), ... SELECT ..." })`
6. Returns formatted table

### 16.2 Source Breakdown

**User:** "Breakdown of leads by source"

**LLM Workflow:**
1. `classify_sales_intent(...)` → `source_daily_breakdown`
2. `get_query_template({ pattern_name: "source_daily_breakdown" })`
3. Builds query with date series cross join, source CASE statement, no progressive day filter
4. `query(...)` → results by source category

### 16.3 Aging Report

**User:** "Show aging prospects"

**LLM Workflow:**
1. `classify_sales_intent(...)` → `prospect_aging`
2. `get_query_template({ pattern_name: "prospect_aging" })`
3. Notes: NO slug exclusions, NO source exclusions, include test record exclusions
4. Builds query with `date(now() + interval '330 minutes') - date(lead_completed_at + interval '330 minutes')` as ageing
5. `query(...)` → list sorted by ageing DESC

### 16.4 Historical Closed Reasons

**User:** "Why did leads close in the last 12 months?"

**LLM Workflow:**
1. `classify_sales_intent(...)` → `historical_funnel_details`
2. `get_query_template({ pattern_name: "historical_funnel_details" })`
3. Uses trailing 12 months filter with `'5 hours 30 minutes'` format
4. Includes closed reason extraction via `jsonb_array_elements`, stage history joins, RANK() for deduplication
5. `query(...)` → detailed records with closed reasons

### 16.5 Database Exploration

**User:** "What tables are in the database?"

**LLM Workflow:**
1. `list_tables({})` → returns all public tables
2. `describe_table({ table_name: "development_opportunities" })` → column details

---

## 17. Adding a New MCP Tool

This section walks through the complete process of adding a new tool to the server. All tool code lives in `src/tools.ts` — both entry points (`index.ts`, `index-sse.ts`) automatically pick up new tools with no changes needed.

### 17.1 Step-by-Step

**Step 1 — Define a Zod validation schema** (in `src/tools.ts`, near line 24)

```typescript
const MyNewToolInputSchema = z.object({
  some_field: z.string().min(1, "some_field cannot be empty"),
  optional_field: z.number().optional(),
});
```

**Step 2 — Add the tool definition** to the `toolDefinitions` array (in `src/tools.ts`, near line 65)

```typescript
{
  name: "my_new_tool",
  description:
    "A clear description of what this tool does. This text is shown to the LLM so it knows when to call the tool.",
  inputSchema: {
    type: "object" as const,
    properties: {
      some_field: {
        type: "string",
        description: "Description of this parameter",
      },
      optional_field: {
        type: "number",
        description: "Optional numeric parameter",
      },
    },
    required: ["some_field"],
  },
},
```

**Step 3 — Add the handler** inside `handleToolCall()` (in `src/tools.ts`, before the `throw new Error("Unknown tool")` line)

```typescript
if (name === "my_new_tool") {
  const { some_field, optional_field } = MyNewToolInputSchema.parse(args);

  // Your logic here — database query, computation, etc.
  const result = await executeReadOnlyQuery(
    "SELECT * FROM my_table WHERE column = $1 LIMIT $2",
    [some_field, optional_field ?? 10]
  );

  return {
    content: [
      { type: "text", text: JSON.stringify(result.rows, null, 2) },
    ],
  };
}
```

**Step 4 — Build and test**

```bash
npm run build
npm run dev:sse
# In another terminal:
curl http://localhost:3000/health
```

### 17.2 Checklist

- Zod schema defined with clear error messages
- Tool added to `toolDefinitions` with `name`, `description`, `inputSchema`
- Handler added in `handleToolCall()` with Zod `.parse(args)` call
- Description is clear enough for an LLM to know when to use it
- `required` array in `inputSchema` lists all mandatory fields
- If the tool queries the database, it uses `executeReadOnlyQuery()`
- No changes needed in `index.ts` or `index-sse.ts`

### 17.3 Tool Design Guidelines

- **Naming:** Use `snake_case` (e.g., `list_tables`, `classify_sales_intent`).
- **Descriptions:** Write for an LLM audience — be explicit about what the tool returns and when to use it.
- **Input schemas:** Must use JSON Schema format (not Zod) in `inputSchema`. Zod is only used for runtime validation in the handler.
- **Error handling:** Throw errors or return `{ isError: true }`. The outer `try/catch` in `handleToolCall()` catches Zod errors and generic errors automatically.
- **Return format:** Always return `{ content: [{ type: "text", text: "..." }] }`. Use `JSON.stringify(data, null, 2)` for structured data.

---

## 18. Adding New Schema Intelligence Rules

This section explains how to extend the sales funnel rules YAML to add new query patterns, business rules, metrics, or funnel stages.

### 18.1 Adding a New Query Pattern

A query pattern represents a distinct type of SQL query the LLM can generate.

**Step 1 — Add to `query_categories`** (if a new category is needed)

```yaml
query_categories:
  my_new_category:
    description: "Description of this category"
    patterns: ["my_new_pattern"]
```

**Step 2 — Add the pattern to `query_patterns`**

```yaml
query_patterns:
  my_new_pattern:
    category: "my_new_category"  # or an existing category
    description: "What this query does"

    user_intent_keywords:
      - "keyword the user might say"
      - "another keyword"

    structure: "Brief description of the SQL structure (e.g. CTE, UNION, single table)"

    applies_date_filter: "mtd_current_progressive"  # reference an existing date filter
    applies_timezone: true
    applies_progressive_filter: true
    applies_slug_exclusions: true
    applies_source_exclusion: false
```

**Step 3 — Add intent keywords** to `intent_classification` (if needed)

```yaml
intent_classification:
  metric_keywords:
    my_new_metric:
      keywords: ["some keyword", "another"]
      suggests_categories: ["my_new_category"]
```

**Step 4 — Add validation checks** to `validation_checklist.category_specific_checks`

```yaml
validation_checklist:
  category_specific_checks:
    my_new_category:
      - id: "my_check"
        rule: "Description of what to verify"
        check: "The SQL pattern to look for"
```

**No code changes are needed.** The schema-rules engine automatically picks up new patterns, categories, and validation checks from the YAML.

### 18.2 Adding a New Core Business Rule

Core rules are mandatory constraints that apply across query categories.

```yaml
core_rules:
  my_new_rule:
    description: "What this rule enforces"
    sql_pattern: "SQL snippet, e.g. column_name IS NOT NULL"
    applies_to: ["mtd_aggregate", "source_breakdown"]  # or "ALL queries"
    mandatory: true
    note: "Any important exceptions or context"
```

The `applies_to` field controls which query categories this rule is returned for:
- `"ALL queries"` — applies universally
- `["category1", "category2"]` — applies only to listed categories

The engine in `schema-rules.ts:getApplicableRules()` automatically filters rules by category.

### 18.3 Adding a New Date Filter

```yaml
date_filters:
  my_new_filter:
    description: "When to use this filter"
    applies_to: ["my_new_category"]
    start_date_sql: "SQL expression for start date"
    end_date_sql: "SQL expression for end date"
    date_filter_sql: |
      ({{timestamp_column}} + interval '330 minutes')::date >= start_expression
      AND ({{timestamp_column}} + interval '330 minutes')::date < end_expression
    progressive_day_filter: false
    progressive_filter_sql: ""  # only if progressive_day_filter is true
```

Reference this filter in your query pattern via `applies_date_filter: "my_new_filter"`.

### 18.4 Adding a New Funnel Stage

```yaml
funnel_stages:
  my_stage:
    description: "What this stage represents"
    timestamp_column: "my_timestamp_column"
    table: "development_opportunities"
    count_expression: "COUNT(DISTINCT(development_opportunities.slug))"
    mandatory_conditions:
      - "my_timestamp_column IS NOT NULL"
    mandatory_exclusions:
      - "slug_exclusions"  # reference a core rule by name
    no_source_exclusion: true  # or false
    applies_timezone: true
    applies_date_filter: true
    applies_progressive_filter: true
```

### 18.5 Adding a New Metric

```yaml
metrics:
  my_metric:
    description: "What this metric measures"
    applies_to: ["mtd_aggregate"]  # which categories include this metric
    patterns_using: ["mtd_funnel_current", "mtd_funnel_last_year"]
    table: "development_opportunities"
    calculation_sql: "SQL expression for the metric"
    aggregation: "AVG"  # or COUNT, SUM, etc.
    timestamp_column: "the_timestamp_to_filter_on"
    applies_timezone: true
    applies_date_filter: true
    applies_progressive_filter: true
    applies_slug_exclusions: true
```

### 18.6 Adding a New Source Category

```yaml
source_mapping:
  categories:
    "My New Category":
      source_values: ["source_value_1", "source_value_2"]
```

Then update the `sql_case_statement` to include the new WHEN clause:

```yaml
source_mapping:
  sql_case_statement: |
    CASE
      ... existing cases ...
      WHEN source IN ('source_value_1','source_value_2') THEN 'My New Category'
      ELSE 'Other'
    END
```

### 18.7 Adding Anti-Patterns

```yaml
anti_patterns:
  - pattern: "Short description of the mistake"
    why: "Why this is wrong"
    wrong: "Example of incorrect SQL"
    correct: "Example of correct SQL"
```

### 18.8 Where Changes Are Needed

| What you're adding | Files to modify | Code changes needed? |
|---|---|---|
| New query pattern | `config/sales_funnel_rules_v2.yml` | No |
| New core rule | `config/sales_funnel_rules_v2.yml` | No |
| New date filter | `config/sales_funnel_rules_v2.yml` | No |
| New funnel stage | `config/sales_funnel_rules_v2.yml` | No |
| New metric | `config/sales_funnel_rules_v2.yml` | No |
| New source category | `config/sales_funnel_rules_v2.yml` | No |
| New anti-pattern | `config/sales_funnel_rules_v2.yml` | No |
| New validation check | `config/sales_funnel_rules_v2.yml` | No |
| New intent keywords | `config/sales_funnel_rules_v2.yml` | No |
| New MCP tool | `src/tools.ts` | Yes — see Section 17 |
| New YAML top-level section | `config/*.yml` + `src/schema-rules.ts` | Yes — update types and loader |

**Key takeaway:** All schema intelligence changes are YAML-only. The engine reads the YAML dynamically — no rebuild or code changes needed. In Docker, the `config/` directory is mounted as a volume, so you can even update rules without restarting the container (rules are cached on first load, so a restart is needed for changes to take effect).

---

## 19. Docker Deployment

### 19.1 Architecture

```
┌──────────────────────────────────────────────────┐
│                 Docker Network                    │
│                                                  │
│  ┌─────────────────┐    ┌─────────────────────┐  │
│  │  lohono-postgres │    │  lohono-mcp-server  │  │
│  │  PostgreSQL 16   │◄───│  Node.js 20         │  │
│  │  Port 5432       │    │  Port 3000          │  │
│  └────────┬────────┘    └────────┬────────────┘  │
│           │                      │               │
└───────────┼──────────────────────┼───────────────┘
            │                      │
       Host:5433              Host:3000
```

### 19.2 Files

- `Dockerfile` — Multi-stage build (builder + production)
- `docker-compose.yml` — Orchestrates both containers
- `.dockerignore` — Excludes node_modules, dist, .git from build context
- `.env.example` — Template for environment variables
- `config/sales_funnel_rules_v2.yml` — Business rules (mounted as volume)

### 19.3 Quick Start

```bash
# Copy and edit environment variables
cp .env.example .env

# Build and start both containers
docker compose up -d

# Verify health
curl http://localhost:3000/health
# {"status":"ok","server":"lohono-db-context","db":"connected"}

# View logs
docker compose logs -f mcp-server

# Stop
docker compose down

# Stop and remove data volume
docker compose down -v
```

### 19.4 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_USER` | `lohono_api` | PostgreSQL user |
| `DB_PASSWORD` | `lohono_api_password` | PostgreSQL password |
| `DB_NAME` | `lohono_api_production` | PostgreSQL database |
| `DB_EXTERNAL_PORT` | `5433` | Host port for PostgreSQL |
| `MCP_PORT` | `3000` | Host port for MCP SSE server |

### 19.5 Updating Rules Without Rebuild

The `config/` directory is mounted as a read-only volume. To update rules:

1. Edit `config/sales_funnel_rules_v2.yml` on the host.
2. Restart the MCP server to pick up changes (rules are cached on first load):
   ```bash
   docker compose restart mcp-server
   ```

### 19.6 Connecting Claude Desktop to Dockerized MCP

Since the Docker setup runs the SSE transport, configure Claude Desktop with the SSE URL:

```json
{
  "mcpServers": {
    "lohono-db-context": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

### 19.7 Rebuilding After Code Changes

```bash
docker compose up -d --build
```
