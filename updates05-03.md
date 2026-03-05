# Aida AI — Updates 05-03-2026

## Overview

Implemented a dynamic query system that transforms Aida into an agent-like platform capable of answering any natural-language data question by generating SQL on the fly, rather than relying solely on predefined queries.

---

## New Features

### 1. Query Knowledge Base (Semantic Search)

**File:** `lohono-mcp-server/src/tools/example-query-search.plugin.ts`

- New MCP tool: `search_example_queries`
- Searches a curated knowledge base of 60 example SQL queries using keyword matching
- Accepts a natural-language question and returns the most relevant example queries with SQL, tables used, and match scores
- Uses token expansion for abbreviations (e.g. YTD -> "year to date", LYTD -> "last year to date", MTD -> "month to date")
- Weighted scoring: name match (1.0), tag match (0.8), description match (0.6), partial matches (0.4/0.2)
- Supports filtering by vertical (`isprava`, `lohono_stays`, `the_chapter`, `solene`) and tags (`funnel`, `scorecard`, `mtd`, `ytd`, etc.)
- Pure JS implementation — no native dependencies, works on Alpine Linux Docker

### 2. Dynamic Query Execution

**File:** `lohono-mcp-server/src/tools/dynamic-query.plugin.ts`

- New MCP tool: `run_dynamic_query`
- Accepts a SQL SELECT query and an explanation, validates it, and executes it against the database
- SQL validation via AST parser (`node-sql-parser`) with regex fallback
- Safety enforcement:
  - Only SELECT queries allowed (blocks INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, etc.)
  - Auto-injects `LIMIT 500` if no LIMIT clause present
  - Executes via `executeReadOnlyQuery()` (wrapped in `BEGIN TRANSACTION READ ONLY`)
- Returns Postgres errors verbatim so Claude can self-correct and retry
- Results cached in Redis with 60-second TTL

### 3. SQL Validator

**File:** `lohono-mcp-server/src/sql-validator.ts`

- AST-level SQL validation using `node-sql-parser`
- Falls back to regex-based validation for complex Postgres syntax the parser can't handle
- Blocks all DML/DDL statements
- Extracts table names from queries for logging/auditing
- Auto-applies LIMIT 500 to prevent unbounded result sets

### 4. Embedding Generation (Offline)

**File:** `lohono-mcp-server/src/embeddings.ts`

- Wrapper around `@xenova/transformers` with `all-MiniLM-L6-v2` model (384 dimensions)
- Used offline by the seed script to generate embeddings for the knowledge base
- Not used at runtime (runtime search uses pure JS keyword matching for Alpine compatibility)

### 5. Knowledge Base Seed Script

**File:** `database/scripts/seed-query-knowledge-base.ts`

- Generates `database/schema/query-knowledge-base.json` from CSV query catalogs (`QueriesSheet1.csv`, `QueriesSheet2.csv`)
- Parses CSV queries, extracts table names, derives tags and verticals from titles
- Generates 384-dimensional embeddings for each entry using `all-MiniLM-L6-v2`
- Run with: `npx tsx database/scripts/seed-query-knowledge-base.ts`
- Output: 60 entries, ~1.1MB JSON file loaded once into memory at server startup

---

## Bug Fixes

### LYTD Funnel - Chapter (Data Fix)

**File:** `database/schema/QueriesSheet1.csv`

- **Problem:** The "LYTD Funnel - Chapter" entry in the query catalog contained a copy of the Isprava SQL (querying `development_opportunities`) instead of the correct Chapter SQL (should query `chapter_opportunities`)
- **Impact:** When users asked "Show me the LYTD funnel for Chapter", the system returned Isprava data
- **Fix:** Replaced the SQL with the correct Chapter version:
  - Uses `chapter_opportunities` table instead of `development_opportunities`
  - Uses `enquiries.vertical='chapter'` instead of `'development'`
  - Uses Chapter-style date format: `date(col + interval '330 minutes')` instead of `col::date`
  - Includes Chapter-specific test record filters: `lower(name) not like '%test%'`
  - Retains LYTD date math: `MAKE_DATE(...) AND (CURRENT_DATE - INTERVAL '1 year')::date`

### Embedding Pre-warm Removed

**File:** `lohono-mcp-server/src/index-sse.ts`

- Removed the embedding model pre-warm code from server startup
- The `@xenova/transformers` ONNX runtime is incompatible with Alpine Linux (requires glibc)
- Since runtime search uses pure JS keyword matching, the embedding import is unnecessary
- Eliminates server startup delays and ONNX crash errors in Docker

---

## Modified Files Summary

| File | Change |
|------|--------|
| `lohono-mcp-server/src/tools/example-query-search.plugin.ts` | New — search example queries tool |
| `lohono-mcp-server/src/tools/dynamic-query.plugin.ts` | New — dynamic SQL execution tool |
| `lohono-mcp-server/src/sql-validator.ts` | New — SQL validation and sanitization |
| `lohono-mcp-server/src/embeddings.ts` | New — embedding generation (offline use) |
| `database/scripts/seed-query-knowledge-base.ts` | New — knowledge base seed script |
| `database/schema/query-knowledge-base.json` | New — generated knowledge base (60 entries) |
| `lohono-mcp-server/src/tools.ts` | Modified — registered new plugins |
| `lohono-mcp-client/src/agent.ts` | Modified — added dynamic query workflow to system prompt |
| `lohono-mcp-server/src/index-sse.ts` | Modified — removed embedding pre-warm |
| `database/schema/QueriesSheet1.csv` | Modified — fixed LYTD Funnel Chapter SQL |
| `package.json` | Modified — added `@xenova/transformers`, `node-sql-parser` |
| `Dockerfile` | Unchanged — remains `node:20-alpine` (no native deps needed) |

---

## Architecture

```
User Question
    |
    v
Claude (Agent Loop)
    |
    +--> Is this a predefined report? --> run_predefined_query
    |
    +--> Is this a sales funnel metric? --> get_sales_funnel
    |
    +--> Otherwise (dynamic query workflow):
            |
            1. search_example_queries  (find similar SQL patterns)
            2. get_table_schema        (verify column names)
            3. Write SQL               (Claude generates query)
            4. run_dynamic_query       (validate + execute)
            5. If error → read error, fix SQL, retry
```

---

## Dependencies Added

- `@xenova/transformers` — Local embedding model for offline knowledge base generation
- `node-sql-parser` — SQL AST parser for query validation
