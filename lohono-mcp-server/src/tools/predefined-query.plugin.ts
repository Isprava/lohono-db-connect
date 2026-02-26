import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import { loadQueryCatalog, matchQueries } from "../predefined-query-loader.js";
import { replaceDatesInSql, computeDefaultDates } from "../predefined-query-date-replacer.js";
import { injectLocationFilter } from "../predefined-query-location-replacer.js";
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
  locations: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional list of locations to filter by (e.g. ['Goa', 'Alibaug']). Fuzzy matching via ILIKE is applied."),
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
      `Optionally provide start_date and end_date (YYYY-MM-DD) to override date boundaries. ` +
      `If no dates are provided, defaults are auto-computed: start_date = current FY start (April 1), ` +
      `end_date = today's IST date. All hardcoded dates and CURRENT_DATE/NOW() expressions are replaced accordingly. ` +
      `Optionally provide locations (e.g. ['Goa', 'Alibaug']) to filter results by location. Fuzzy matching is applied.`,
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
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of locations to filter by (e.g. ['Goa', 'Alibaug']). Fuzzy matching is applied.",
        },
      },
      required: ["query"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = RunPredefinedQueryInputSchema.parse(args);
    const { query: searchTerm, start_date, end_date, locations } = parsed;
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

    // Always apply date replacements — compute defaults from today's IST date
    // if the caller did not provide explicit dates.
    const defaults = computeDefaultDates();
    const effectiveStartDate = start_date || defaults.startDate;
    const effectiveEndDate = end_date || defaults.endDate;
    sql = replaceDatesInSql(sql, effectiveStartDate, effectiveEndDate);

    // Apply location filter if locations provided
    if (locations && locations.length > 0) {
      sql = injectLocationFilter(sql, locations);
    }

    // Check cache (include locations in key for correct cache isolation)
    const locKey = locations && locations.length > 0 ? locations.sort().join(",") : "";
    const cacheKey = `predefined:${best.entry.title}:${effectiveStartDate}:${effectiveEndDate}:${locKey}`;
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
    const ttl = isHistoricalRange(effectiveEndDate)
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
