import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import { validateAndSanitize } from "../sql-validator.js";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";

// ── Input schema ────────────────────────────────────────────────────────────

const RunDynamicQueryInputSchema = z.object({
  sql: z.string().min(1, "SQL query is required"),
  explanation: z.string().min(1, "Explanation of what this query does is required"),
});

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const DYNAMIC_QUERY_TTL = 60; // 60 seconds — dynamic queries are always fresh-ish
const queryCache = new RedisCache<CacheEntry>("query:dynamic", DYNAMIC_QUERY_TTL);

// ── Debug mode ──────────────────────────────────────────────────────────────

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// ── Plugin ──────────────────────────────────────────────────────────────────

export const runDynamicQueryPlugin: ToolPlugin = {
  definition: {
    name: "run_dynamic_query",
    description:
      `Execute a read-only SQL query against the database. Use this when no predefined query or sales funnel tool covers the user's question. ` +
      `BEFORE writing SQL, ALWAYS call search_example_queries first to find similar query patterns — use those as templates for correct joins and filters. ` +
      `Also call get_table_schema to verify column names before using them. ` +
      `Rules: Only SELECT queries allowed. A LIMIT of 500 is auto-applied if missing. ` +
      `If the query fails, read the Postgres error message carefully and fix the SQL. ` +
      `You MUST provide an explanation of what the query does and why.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "The SQL SELECT query to execute.",
        },
        explanation: {
          type: "string",
          description: "Brief explanation of what this query does and why it answers the user's question.",
        },
      },
      required: ["sql", "explanation"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = RunDynamicQueryInputSchema.parse(args);
    const { sql: rawSql, explanation } = parsed;
    const startTime = Date.now();

    logger.info("run_dynamic_query called", { explanation, sqlLength: rawSql.length });

    // ── Step 1: Validate and sanitize SQL ──────────────────────────────────
    const validation = validateAndSanitize(rawSql);

    if (!validation.safe) {
      logger.warn("run_dynamic_query rejected", { error: validation.error, sql: rawSql });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: validation.error,
            suggestion: "Only SELECT queries are allowed. Please rewrite your query.",
          }, null, 2),
        }],
        isError: true,
      };
    }

    const safeSql = validation.sanitizedSql;

    logger.info("run_dynamic_query executing", {
      tables: validation.tables,
      limitApplied: validation.limitApplied,
      sql: safeSql,
    });

    // ── Step 2: Check cache ────────────────────────────────────────────────
    const cacheKey = `dynamic:${safeSql}`;
    const cached = await queryCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: dynamic query`);
      const responseData: Record<string, unknown> = {
        explanation,
        tables_accessed: validation.tables,
        rowCount: cached.rowCount,
        rows: cached.rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "run_dynamic_query",
          cacheHit: true,
          sql: safeSql,
          tables: validation.tables,
          limitApplied: validation.limitApplied,
          executionMs: Date.now() - startTime,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
    }

    // ── Step 3: Execute query ──────────────────────────────────────────────
    try {
      const result = await executeReadOnlyQuery(safeSql, []);
      const rows = result.rows as Record<string, unknown>[];

      await queryCache.set(cacheKey, { rows, rowCount: result.rowCount }, DYNAMIC_QUERY_TTL);

      const executionMs = Date.now() - startTime;
      logger.info("run_dynamic_query completed", {
        rowCount: result.rowCount,
        executionMs,
      });

      const responseData: Record<string, unknown> = {
        explanation,
        tables_accessed: validation.tables,
        rowCount: result.rowCount,
        rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "run_dynamic_query",
          cacheHit: false,
          sql: safeSql,
          tables: validation.tables,
          limitApplied: validation.limitApplied,
          rowCount: result.rowCount,
          executionMs,
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const executionMs = Date.now() - startTime;

      logger.error("run_dynamic_query failed", {
        error: message,
        sql: safeSql,
        executionMs,
      });

      // Return the Postgres error verbatim so Claude can self-correct
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: message,
            failed_sql: safeSql,
            tables_attempted: validation.tables,
            suggestion: "Read the error message above. Common fixes: check column names with get_table_schema, verify table names with search_tables, fix JOIN conditions using the relationship graph.",
          }, null, 2),
        }],
        isError: true,
      };
    }
  },
};

export const dynamicQueryPlugins: ToolPlugin[] = [runDynamicQueryPlugin];
