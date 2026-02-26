import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import { loadQueryCatalog, matchQueries } from "../predefined-query-loader.js";
import { replaceDatesInSql } from "../predefined-query-date-replacer.js";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";

// ── Input schema ────────────────────────────────────────────────────────────

const RunPredefinedQueryInputSchema = z.object({
  query: z.string().min(1, "query search term is required"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "start_date must be YYYY-MM-DD")
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be YYYY-MM-DD")
    .optional(),
});

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const HISTORICAL_TTL = 86_400; // 24 hours
const CURRENT_TTL = 60;        // 60 seconds

const queryCache = new RedisCache<CacheEntry>("query:predefined", CURRENT_TTL);

/** Returns true if the entire date range falls before the current month in IST. */
function isHistoricalRange(endDate: string): boolean {
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffsetMs);
  const startOfMonthIst = new Date(nowIst.getFullYear(), nowIst.getMonth(), 1);
  const endParsed = new Date(endDate + "T00:00:00");
  return endParsed < startOfMonthIst;
}

// ── Config ──────────────────────────────────────────────────────────────────

const DEBUG_MODE = process.env.DEBUG_MODE === "true";
const MATCH_THRESHOLD = 0.4;

// ── Plugin ──────────────────────────────────────────────────────────────────

export const runPredefinedQueryPlugin: ToolPlugin = {
  definition: {
    name: "run_predefined_query",
    description:
      `Runs a predefined SQL query from the curated query catalog. ` +
      `Provide a natural-language search term (e.g. "orderbook actuals", "scorecard MTD isprava", ` +
      `"lead to prospect conversion chapter") and the tool will fuzzy-match it to the best query. ` +
      `Optionally provide start_date and end_date (YYYY-MM-DD) to override the default FY date boundaries in the query. ` +
      `If no dates are provided, queries that use dynamic dates (CURRENT_DATE, NOW()) will work as-is, ` +
      `while queries with hardcoded dates will use their original FY 2025-26 values.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural-language search term to match against predefined query titles.",
        },
        start_date: {
          type: "string",
          description: "Optional FY start date in YYYY-MM-DD format (e.g. '2025-04-01'). Used to replace hardcoded date boundaries.",
        },
        end_date: {
          type: "string",
          description: "Optional period end date in YYYY-MM-DD format (e.g. '2026-02-28'). Used to replace hardcoded date boundaries.",
        },
      },
      required: ["query"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = RunPredefinedQueryInputSchema.parse(args);
    const { query: searchTerm, start_date, end_date } = parsed;
    const startTime = Date.now();

    // ── Load catalog & match ──────────────────────────────────────────────
    const catalog = loadQueryCatalog();
    const matches = matchQueries(searchTerm, catalog);

    // ── No match ──────────────────────────────────────────────────────────
    if (matches.length === 0 || matches[0].score < MATCH_THRESHOLD) {
      const titles = catalog.map((e) => e.title);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No confident match found for "${searchTerm}".`,
            suggestion: "Please try one of the available queries:",
            available_queries: titles,
          }, null, 2),
        }],
        isError: true,
      };
    }

    // ── Ambiguous ties — multiple queries with the same top score ────────
    const topScore = matches[0].score;
    const topMatches = matches.filter((m) => m.score === topScore);
    if (topMatches.length > 1 && topScore < 1.0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Multiple queries matched "${searchTerm}" with equal confidence (${(topScore * 100).toFixed(0)}%).`,
            suggestion: "Please be more specific. Did you mean one of these?",
            candidates: topMatches.map((m) => m.entry.title),
          }, null, 2),
        }],
        isError: true,
      };
    }

    // ── Confident match — execute ─────────────────────────────────────────
    const best = matches[0];
    let sql = best.entry.sql;

    // Apply date replacements if dates provided
    if (start_date && end_date) {
      sql = replaceDatesInSql(sql, start_date, end_date);
    }

    // Check cache
    const cacheKey = `predefined:${best.entry.title}:${start_date || ""}:${end_date || ""}`;
    const cached = await queryCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      const responseData: Record<string, unknown> = {
        query_title: best.entry.title,
        match_score: best.score,
        rowCount: cached.rowCount,
        rows: cached.rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "run_predefined_query",
          cacheHit: true,
          cacheKey,
          sql,
          matchScore: best.score,
          executionMs: Date.now() - startTime,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
      };
    }

    // Execute query
    const result = await executeReadOnlyQuery(sql, []);
    const rows = result.rows as Record<string, unknown>[];

    // Determine TTL
    const ttl = (start_date && end_date && isHistoricalRange(end_date))
      ? HISTORICAL_TTL
      : CURRENT_TTL;
    await queryCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

    const responseData: Record<string, unknown> = {
      query_title: best.entry.title,
      match_score: best.score,
      rowCount: result.rowCount,
      rows,
    };
    if (DEBUG_MODE) {
      responseData._debug = {
        tool: "run_predefined_query",
        cacheHit: false,
        sql,
        matchScore: best.score,
        ttl,
        rowCount: result.rowCount,
        executionMs: Date.now() - startTime,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
    };
  },
};

/** All predefined query tool plugins */
export const predefinedQueryPlugins: ToolPlugin[] = [runPredefinedQueryPlugin];
