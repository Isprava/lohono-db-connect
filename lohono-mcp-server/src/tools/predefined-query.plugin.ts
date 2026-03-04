import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import { loadQueryCatalog, matchQueries, type QueryEntry } from "../predefined-query-loader.js";
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
  variant: z
    .enum(["with_extensions", "without_extensions"])
    .optional()
    .describe("For QueriesSheet2 queries that exist in both variants: 'with_extensions' or 'without_extensions'. If omitted, both variants are executed and returned side by side."),
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

// ── Shared execution helper ─────────────────────────────────────────────

interface ExecOpts {
  start_date?: string;
  end_date?: string;
  locations?: string[];
  startTime: number;
}

async function executeEntry(
  entry: QueryEntry,
  matchScore: number,
  opts: ExecOpts,
): Promise<ToolResult & { content: [{ type: "text"; text: string }] }> {
  const defaults = computeDefaultDates();
  const effectiveStartDate = opts.start_date || defaults.startDate;
  const effectiveEndDate = opts.end_date || defaults.endDate;

  let sql = entry.sql;
  sql = replaceDatesInSql(sql, effectiveStartDate, effectiveEndDate);

  if (opts.locations && opts.locations.length > 0) {
    sql = injectLocationFilter(sql, opts.locations);
  }

  const variantLabel = entry.variant ? ` [${entry.variant}]` : "";
  logger.info("run_predefined_query executing", {
    matchedTitle: entry.title,
    variant: entry.variant,
    matchScore,
    effectiveStartDate,
    effectiveEndDate,
    locations: opts.locations,
    sql,
  });

  // Cache key includes variant for isolation
  const locKey = opts.locations && opts.locations.length > 0 ? opts.locations.sort().join(",") : "";
  const cacheKey = `predefined:${entry.title}:${entry.variant || "default"}:${effectiveStartDate}:${effectiveEndDate}:${locKey}`;
  const cached = await queryCache.get(cacheKey);
  if (cached) {
    logger.info(`Cache hit: ${cacheKey}`);
    const responseData: Record<string, unknown> = {
      query_title: `${entry.title}${variantLabel}`,
      match_score: matchScore,
      rowCount: cached.rowCount,
      rows: cached.rows,
    };
    if (DEBUG_MODE) {
      responseData._debug = {
        tool: "run_predefined_query",
        cacheHit: true,
        cacheKey,
        sql,
        variant: entry.variant,
        matchScore,
        executionMs: Date.now() - opts.startTime,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
  }

  const result = await executeReadOnlyQuery(sql, []);
  const rows = result.rows as Record<string, unknown>[];

  const ttl = isHistoricalRange(effectiveEndDate) ? HISTORICAL_TTL : CURRENT_TTL;
  await queryCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

  const responseData: Record<string, unknown> = {
    query_title: `${entry.title}${variantLabel}`,
    match_score: matchScore,
    rowCount: result.rowCount,
    rows,
  };
  if (DEBUG_MODE) {
    responseData._debug = {
      tool: "run_predefined_query",
      cacheHit: false,
      sql,
      variant: entry.variant,
      matchScore,
      ttl,
      rowCount: result.rowCount,
      executionMs: Date.now() - opts.startTime,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
}

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
      `Optionally provide locations (e.g. ['Goa', 'Alibaug']) to filter results by location. Fuzzy matching is applied. ` +
      `ALWAYS use this tool for named funnel reports: "YTD Funnel Isprava", "LYTD Funnel Isprava", "YTD Funnel Chapter", "LYTD Funnel Chapter", "FY Funnel", "Weekly Insights". ` +
      `Do NOT use get_sales_funnel for these — this tool has the correct SQL.`,
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
        variant: {
          type: "string",
          enum: ["with_extensions", "without_extensions"],
          description: "For QueriesSheet2 queries that exist in both variants: 'with_extensions' or 'without_extensions'. If omitted, both variants are executed and returned side by side.",
        },
      },
      required: ["query"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = RunPredefinedQueryInputSchema.parse(args);
    const { query: searchTerm, start_date, end_date, locations, variant } = parsed;
    const startTime = Date.now();
    logger.info("run_predefined_query called", {
      searchTerm,
      start_date,
      end_date,
      locations,
      variant,
    });

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

    // ── Ambiguous ties — multiple queries with the same score AND title length ─
    const topScore = matches[0].score;
    const topLen = matches[0].entry.tokens.length;
    let topMatches = matches.filter((m) => m.score === topScore && m.entry.tokens.length === topLen);

    // If multiple distinct titles are tied, try to break the tie by checking
    // which title contains the search tokens in order (substring match).
    const distinctTitles = new Set(topMatches.map((m) => m.entry.title));
    if (distinctTitles.size > 1) {
      const searchLower = searchTerm.toLowerCase();
      const substringMatches = topMatches.filter(
        (m) => m.entry.title.toLowerCase().includes(searchLower),
      );
      if (substringMatches.length > 0 && new Set(substringMatches.map((m) => m.entry.title)).size < distinctTitles.size) {
        topMatches = substringMatches;
      }
    }

    // Check if ambiguity is due to variant duplicates (same title, different variants)
    const isVariantAmbiguity = topMatches.length > 1 &&
      topMatches.every((m) => m.entry.variant !== undefined) &&
      new Set(topMatches.map((m) => m.entry.title)).size === 1;

    if (isVariantAmbiguity) {
      // Filter by requested variant, or run both if not specified
      if (variant) {
        const filtered = topMatches.filter((m) => m.entry.variant === variant);
        if (filtered.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `No "${variant}" variant found for "${searchTerm}".`,
                available_variants: topMatches.map((m) => m.entry.variant),
              }, null, 2),
            }],
            isError: true,
          };
        }
        // Execute single variant
        return await executeEntry(filtered[0].entry, filtered[0].score, {
          start_date, end_date, locations, startTime,
        });
      }

      // No variant specified — run both and return side by side
      const results = await Promise.all(
        topMatches.map((m) =>
          executeEntry(m.entry, m.score, { start_date, end_date, locations, startTime })
            .then((res) => {
              const data = JSON.parse(res.content[0].text);
              return { variant: m.entry.variant!, data };
            })
        )
      );

      const combined: Record<string, unknown> = {
        query_title: topMatches[0].entry.title,
        match_score: topScore,
        variants: Object.fromEntries(results.map((r) => [r.variant, r.data])),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(combined, null, 2) }],
      };
    }

    // Non-variant ambiguity — genuine conflict, ask user to disambiguate
    if (topMatches.length > 1) {
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

    // ── Confident single match — execute ──────────────────────────────────
    return await executeEntry(matches[0].entry, matches[0].score, {
      start_date, end_date, locations, startTime,
    });
  },
};

/** All predefined query tool plugins */
export const predefinedQueryPlugins: ToolPlugin[] = [runPredefinedQueryPlugin];
