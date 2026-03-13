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
    .describe("Optional list of locations to include (e.g. ['Goa', 'Alibaug']). Fuzzy matching via ILIKE is applied."),
  exclude_locations: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional list of locations to exclude (e.g. ['Goa']). Rows matching these locations are removed from results via NOT ILIKE."),
  variant: z
    .enum(["with_extensions", "without_extensions"])
    .optional()
    .describe("For QueriesSheet2 queries that exist in both variants: 'with_extensions' or 'without_extensions'. If omitted, both variants are executed and returned side by side."),
  summarize_by: z
    .string()
    .optional()
    .describe("Optional column name to group and summarize results by (e.g. 'location', 'vertical'). When provided, the server computes totals server-side and returns a summary table. Use this when the user asks to summarize, aggregate, or get totals from a previous query result. Do NOT compute summaries yourself — always use this parameter so the server calculates accurate values."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset (0-based) — skip this many rows before returning results. Default: 0. Use this with page_size for flexible pagination. Example: offset=0 page_size=25 returns rows 1-25, then offset=25 page_size=30 returns rows 26-55 with no gaps. IMPORTANT: NEVER generate data from memory — always call the tool with the correct offset."),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of rows to return (default: 25, max: 100). Can be changed freely between requests since offset-based pagination has no gaps."),
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

// ── Placeholder detection ────────────────────────────────────────────────

const REDASH_DATE_PLACEHOLDER_RE = /\{\{\s*(Start Date|End Date)\s*\}\}/i;

/** Check if a query's raw SQL contains Redash-style date placeholders. */
function hasDatePlaceholders(sql: string): boolean {
  return REDASH_DATE_PLACEHOLDER_RE.test(sql);
}

// ── Queries that manage their own date boundaries ───────────────────────
// These queries use dynamic expressions (now(), CURRENT_DATE) internally
// and have multi-boundary FY logic that the generic date replacer would break.
const SKIP_DATE_REPLACEMENT_TITLES = new Set([
  "Collection Summary - Consolidated Dashboard Query",
  "Ageing Analysis - Consolidated Dashboard Query",
  "Isprava Scorecard Metrics",
  "Chapter Scorecard Metrics",
]);

/** Returns true if a query title should skip the generic date replacement. */
function shouldSkipDateReplacement(title: string): boolean {
  return SKIP_DATE_REPLACEMENT_TITLES.has(title);
}

// ── Pre-formatted table for large result sets ───────────────────────────
// Queries with many rows cause Claude to hallucinate values when
// reformatting JSON into markdown tables. Pre-formatting server-side
// ensures data integrity. Applied to ANY result set above the threshold.

const PREFORMAT_ROW_THRESHOLD = 20;

/** Format a number with commas and 2 decimal places (e.g. 17,00,000.00). */
function fmtNum(v: unknown): string {
  const n = Number(v);
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Detect which columns are numeric by inspecting the first few rows. */
function classifyColumns(rows: Record<string, unknown>[]): { text: string[]; numeric: string[] } {
  const cols = Object.keys(rows[0] || {});
  const text: string[] = [];
  const numeric: string[] = [];
  for (const col of cols) {
    // Sample up to 5 non-null values
    const samples = rows.slice(0, 5).map((r) => r[col]).filter((v) => v != null);
    const allNumeric = samples.length > 0 && samples.every((v) => typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v))));
    if (allNumeric) numeric.push(col);
    else text.push(col);
  }
  return { text, numeric };
}

/** Build a pre-formatted markdown table from query rows. */
function preformatTable(rows: Record<string, unknown>[]): string {
  const columns = Object.keys(rows[0] || {});
  const { numeric } = classifyColumns(rows);
  const numericSet = new Set(numeric);

  const header = "| " + columns.join(" | ") + " |";
  const separator = "| " + columns.map(() => "---").join(" | ") + " |";
  const dataRows = rows.map((row) => {
    return "| " + columns.map((col) => {
      const val = row[col];
      if (numericSet.has(col)) return fmtNum(val);
      return String(val ?? "");
    }).join(" | ") + " |";
  });

  return [header, separator, ...dataRows].join("\n");
}

/** Build a summary table grouped by a key column, summing all numeric columns. */
function buildSummaryTable(rows: Record<string, unknown>[], groupByCol: string): string {
  if (rows.length === 0) return "";
  const { numeric } = classifyColumns(rows);
  if (numeric.length === 0) return "";

  const groups = new Map<string, Record<string, number>>();
  const propertyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[groupByCol] ?? "Unknown");
    if (!groups.has(key)) {
      groups.set(key, Object.fromEntries(numeric.map((c) => [c, 0])));
      propertyCounts.set(key, 0);
    }
    propertyCounts.set(key, (propertyCounts.get(key) || 0) + 1);
    const sums = groups.get(key)!;
    for (const col of numeric) {
      const v = Number(row[col]);
      if (!isNaN(v)) sums[col] += v;
    }
  }

  const cols = [groupByCol, "properties", ...numeric];
  const header = "| " + cols.join(" | ") + " |";
  const separator = "| " + cols.map(() => "---").join(" | ") + " |";
  const dataRows: string[] = [];
  for (const [key, sums] of groups) {
    const cells = [key, String(propertyCounts.get(key) || 0), ...numeric.map((c) => fmtNum(sums[c]))];
    dataRows.push("| " + cells.join(" | ") + " |");
  }

  return [header, separator, ...dataRows].join("\n");
}

// ── Shared execution helper ─────────────────────────────────────────────

interface ExecOpts {
  start_date?: string;
  end_date?: string;
  locations?: string[];
  exclude_locations?: string[];
  summarize_by?: string;
  offset?: number;
  page_size?: number;
  startTime: number;
}

/** Internal: execute a query entry and return raw rows (no formatting). */
async function executeEntryRaw(
  entry: QueryEntry,
  opts: ExecOpts,
): Promise<Record<string, unknown>[]> {
  const defaults = computeDefaultDates();
  const effectiveStartDate = opts.start_date || defaults.startDate;
  const effectiveEndDate = opts.end_date || defaults.endDate;

  let sql = entry.sql;
  if (!shouldSkipDateReplacement(entry.title)) {
    sql = replaceDatesInSql(sql, effectiveStartDate, effectiveEndDate);
  }

  const hasLocFilter = (opts.locations && opts.locations.length > 0) ||
    (opts.exclude_locations && opts.exclude_locations.length > 0);
  if (hasLocFilter) {
    sql = injectLocationFilter(sql, opts.locations, opts.exclude_locations);
  }

  logger.info("run_predefined_query executing (raw)", {
    matchedTitle: entry.title,
    variant: entry.variant,
    effectiveStartDate,
    effectiveEndDate,
    locations: opts.locations,
    sql,
  });

  const locKey = opts.locations && opts.locations.length > 0 ? opts.locations.sort().join(",") : "";
  const exLocKey = opts.exclude_locations && opts.exclude_locations.length > 0 ? "ex:" + opts.exclude_locations.sort().join(",") : "";
  const cacheKey = `predefined:${entry.title}:${entry.variant || "default"}:${effectiveStartDate}:${effectiveEndDate}:${locKey}:${exLocKey}`;
  const cached = await queryCache.get(cacheKey);
  if (cached) {
    logger.info(`Cache hit: ${cacheKey}`);
    return cached.rows;
  }

  const result = await executeReadOnlyQuery(sql, []);
  const rows = result.rows as Record<string, unknown>[];

  const ttl = isHistoricalRange(effectiveEndDate) ? HISTORICAL_TTL : CURRENT_TTL;
  await queryCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

  return rows;
}

async function executeEntry(
  entry: QueryEntry,
  matchScore: number,
  opts: ExecOpts,
): Promise<ToolResult & { content: [{ type: "text"; text: string }] }> {
  const rows = await executeEntryRaw(entry, opts);
  const variantLabel = entry.variant ? ` [${entry.variant}]` : "";

  // If summarize_by is requested, return only the summary table
  if (opts.summarize_by) {
    const col = opts.summarize_by;
    const colExists = rows.length > 0 && col in rows[0];
    if (!colExists) {
      const availableCols = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Column "${col}" not found in query results.`,
            available_columns: availableCols,
          }, null, 2),
        }],
      };
    }
    const summary = buildSummaryTable(rows, col);
    const responseText = `Query: ${entry.title} (Summary by ${col})\nRows: ${rows.length} rows summarized\n\nIMPORTANT: Present this table EXACTLY as shown below. These values are computed server-side. Do NOT modify, recalculate, or re-derive any values.\n\n${summary}`;
    return { content: [{ type: "text", text: responseText }] };
  }

  // Apply offset-based pagination for large result sets
  const totalRows = rows.length;
  const pageSize = opts.page_size || 25;
  const startIdx = opts.offset || 0;

  let displayRows = rows;
  let paginationInfo = "";
  if (totalRows > pageSize) {
    const endIdx = Math.min(startIdx + pageSize, totalRows);
    displayRows = rows.slice(startIdx, endIdx);
    paginationInfo = `\nShowing rows ${startIdx + 1}-${endIdx} of ${totalRows}.`;
    if (endIdx < totalRows) {
      paginationInfo += ` To see the next rows, call this tool again with the same query, offset: ${endIdx}, and page_size: ${pageSize}.`;
    }
  }

  // Pre-format large result sets as markdown to prevent Claude hallucination
  if (displayRows.length > PREFORMAT_ROW_THRESHOLD || totalRows > pageSize) {
    const table = preformatTable(displayRows);
    const header = `**${entry.title}**\nTotal rows: ${totalRows}${paginationInfo}\n\n`;
    const footer = paginationInfo ? `\n\n_Use offset parameter to see more rows._` : "";
    const responseText = `<<DIRECT_TABLE>>${header}${table}${footer}<<END_TABLE>>\nThe table above (${displayRows.length} rows) has been displayed directly to the user. Do NOT repeat or reproduce the table data. Instead, add a brief note: mention the total row count (${totalRows}), current page info, and ask if they want to see more rows, filter by location, or get a summary.`;
    return { content: [{ type: "text", text: responseText }] };
  }

  const responseData: Record<string, unknown> = {
    query_title: `${entry.title}${variantLabel}`,
    match_score: matchScore,
    rowCount: rows.length,
    rows,
  };
  if (DEBUG_MODE) {
    responseData._debug = {
      tool: "run_predefined_query",
      cacheHit: false,
      matchScore,
      variant: entry.variant,
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
      `Optionally provide locations to include or exclude_locations to exclude (e.g. exclude_locations: ['Goa'] for non-Goa data). Fuzzy matching is applied. ` +
      `ALWAYS use this tool for named funnel reports: "YTD Funnel Isprava", "LYTD Funnel Isprava", "YTD Funnel Chapter", "LYTD Funnel Chapter", "FY Funnel", "Weekly Insights". ` +
      `Do NOT use get_sales_funnel for these — this tool has the correct SQL. ` +
      `SCORECARD QUERIES: When the user asks for "scorecard data", "scorecard consolidated", or similar scorecard requests WITHOUT specifying a time period (MTD/YTD/LYTD/etc.), ` +
      `call this tool with query "scorecard metrics" — it will automatically run BOTH Isprava and Chapter Scorecard Metrics and return combined results. ` +
      `Do NOT ask the user which vertical (Isprava/Chapter) or which time period — just call the tool directly. ` +
      `If the user specifies a vertical (e.g. "isprava scorecard"), pass that in the query. ` +
      `If the user specifies a period (e.g. "scorecard MTD"), pass that in the query to match period-specific queries.`,
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
          description: "Optional list of locations to include (e.g. ['Goa', 'Alibaug']). Fuzzy matching via ILIKE is applied.",
        },
        exclude_locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of locations to exclude (e.g. ['Goa']). Rows matching these locations are removed from results via NOT ILIKE.",
        },
        variant: {
          type: "string",
          enum: ["with_extensions", "without_extensions"],
          description: "For QueriesSheet2 queries that exist in both variants: 'with_extensions' or 'without_extensions'. If omitted, both variants are executed and returned side by side.",
        },
        summarize_by: {
          type: "string",
          description: "Column name to group and summarize results by (e.g. 'location', 'vertical'). When provided, the server computes accurate totals and returns a summary table instead of raw rows. ALWAYS use this when the user asks to summarize, aggregate, or get totals — do NOT compute summaries yourself.",
        },
        offset: {
          type: "number",
          description: "Row offset (0-based) — skip this many rows. Default: 0. Example: offset=0 page_size=25 → rows 1-25, then offset=25 page_size=30 → rows 26-55. NEVER generate data from memory — always call the tool with the correct offset.",
        },
        page_size: {
          type: "number",
          description: "Number of rows to return (default: 25, max: 100).",
        },
      },
      required: ["query"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = RunPredefinedQueryInputSchema.parse(args);
    let { query: searchTerm, start_date, end_date, locations, exclude_locations, variant, summarize_by, offset, page_size } = parsed;
    const startTime = Date.now();
    logger.info("run_predefined_query called", {
      searchTerm,
      start_date,
      end_date,
      locations,
      exclude_locations,
      variant,
      summarize_by,
    });

    // ── Load catalog & match ──────────────────────────────────────────────
    const catalog = loadQueryCatalog();

    // ── Scorecard shortcut: when search mentions "scorecard" without a
    //    specific period keyword, directly run the Scorecard Metrics queries
    //    instead of relying on fuzzy matching. ──────────────────────────────
    const searchLowerEarly = searchTerm.toLowerCase();
    const isScorecardSearch = /\bscorecard\b/.test(searchLowerEarly);
    const hasPeriodKeywordEarly = /\b(mtd|ytd|lytd|lymtd|lmtd|weekly)\b/.test(searchLowerEarly);

    if (isScorecardSearch && !hasPeriodKeywordEarly) {
      const wantsIsprava = /\bisprava\b/.test(searchLowerEarly);
      const wantsChapter = /\bchapter\b/.test(searchLowerEarly);

      const scorecardMetrics = catalog.filter((e) =>
        e.title.toLowerCase().includes("scorecard metrics")
      );

      if (scorecardMetrics.length > 0) {
        if (wantsIsprava || wantsChapter) {
          // Single vertical requested
          const target = scorecardMetrics.find((e) => {
            const t = e.title.toLowerCase();
            return wantsIsprava ? t.includes("isprava") : t.includes("chapter");
          });
          if (target) {
            return await executeEntry(target, 1.0, {
              start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime,
            });
          }
        } else {
          // No vertical — run both Isprava + Chapter, merge into single table
          const results = await Promise.all(
            scorecardMetrics.map((entry) => {
              const vertical = entry.title.toLowerCase().includes("isprava") ? "Isprava" : "Chapter";
              return executeEntryRaw(entry, { start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime })
                .then((rows) => rows.map((row) => ({ vertical, ...row })));
            })
          );

          const mergedRows = results.flat();
          const rowCount = mergedRows.length;
          // If summarize_by is provided, return only the summary
          if (summarize_by) {
            const colExists = mergedRows.length > 0 && summarize_by in mergedRows[0];
            if (!colExists) {
              const availableCols = mergedRows.length > 0 ? Object.keys(mergedRows[0]) : [];
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: `Column "${summarize_by}" not found in query results.`,
                    available_columns: availableCols,
                  }, null, 2),
                }],
              };
            }
            const summary = buildSummaryTable(mergedRows, summarize_by);
            const responseText = `Query: Scorecard Dashboard (Isprava + Chapter) — Summary by ${summarize_by}\nRows: ${rowCount} rows summarized\n\nIMPORTANT: Present this table EXACTLY as shown below. These values are computed server-side. Do NOT modify, recalculate, or re-derive any values.\n\n${summary}`;
            return { content: [{ type: "text", text: responseText }] };
          }

          // Default: detail with offset-based pagination
          const pSize = page_size || 25;
          const startIdx = offset || 0;
          let displayRows = mergedRows;
          let pgInfo = "";
          if (rowCount > pSize) {
            const endIdx = Math.min(startIdx + pSize, rowCount);
            displayRows = mergedRows.slice(startIdx, endIdx);
            pgInfo = `\nShowing rows ${startIdx + 1}-${endIdx} of ${rowCount}.`;
            if (endIdx < rowCount) {
              pgInfo += ` To see the next rows, call this tool again with the same query, offset: ${endIdx}, and page_size: ${pSize}.`;
            }
          }

          const table = preformatTable(displayRows);
          const header = `**Scorecard Dashboard (Isprava + Chapter)**\nTotal rows: ${rowCount}${pgInfo}\n\n`;
          const footer = pgInfo ? `\n\n_Use offset parameter to see more rows._` : "";
          const responseText = `<<DIRECT_TABLE>>${header}${table}${footer}<<END_TABLE>>\nThe table above (${displayRows.length} rows) has been displayed directly to the user. Do NOT repeat or reproduce the table data. Instead, add a brief note: mention the total row count (${rowCount}), current page info, and ask if they want to see more rows, filter, or summarize.`;
          return { content: [{ type: "text", text: responseText }] };
        }
      }
    }

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

    // ── Strip agent-computed dates for queries with built-in date periods ──
    // When the query title contains a date-period keyword (MTD, YTD, etc.),
    // the SQL already has the correct date logic. The agent may incorrectly
    // compute dates from the keyword (e.g. "YTD" → Jan 1) — ignore them.
    // We keep end_date to allow "as of" overrides (e.g. "YTD as of Feb 15").
    const DATE_PERIOD_RE = /\b(MTD|YTD|FYTD|LYTD|LYMTD|LMTD)\b/i;
    const bestEntry = matches[0].entry;
    if (DATE_PERIOD_RE.test(bestEntry.title) && start_date) {
      logger.info("Ignoring agent-computed start_date for date-period query", {
        queryTitle: bestEntry.title,
        ignoredStartDate: start_date,
      });
      start_date = undefined;
    }

    // ── Check if matched query requires user-provided dates ───────────────
    // Queries with Redash-style {{Start Date}} / {{End Date}} placeholders
    // need explicit dates from the user. If none were provided, return a
    // structured response telling the agent to ask the user.
    const userProvidedDates = !!(start_date && end_date);
    if (hasDatePlaceholders(bestEntry.sql) && !userProvidedDates) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dates_required: true,
            query_title: bestEntry.title,
            message: `The query "${bestEntry.title}" requires a date range. Please provide start_date and end_date (YYYY-MM-DD) to run this query.`,
          }, null, 2),
        }],
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
          start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime,
        });
      }

      // No variant specified — run both and return side by side
      const results = await Promise.all(
        topMatches.map((m) =>
          executeEntry(m.entry, m.score, { start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime })
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

    // Same-title duplicates — run all and return combined results
    const isSameTitleDuplicates = topMatches.length > 1 &&
      new Set(topMatches.map((m) => m.entry.title)).size === 1;

    if (isSameTitleDuplicates) {
      const results = await Promise.all(
        topMatches.map((m, idx) =>
          executeEntry(m.entry, m.score, { start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime })
            .then((res) => {
              const data = JSON.parse(res.content[0].text);
              return { label: `result_${idx + 1}`, data };
            })
        )
      );

      const combined: Record<string, unknown> = {
        query_title: topMatches[0].entry.title,
        match_score: topScore,
        results: Object.fromEntries(results.map((r) => [r.label, r.data])),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(combined, null, 2) }],
      };
    }

    // ── Scorecard default: prefer "Metrics" queries when no period specified ──
    // When multiple scorecard queries tie and the search has no period keyword
    // (MTD, YTD, etc.), auto-select the Scorecard Metrics queries.
    if (topMatches.length > 1) {
      const searchLower = searchTerm.toLowerCase();
      const hasPeriodKeyword = /\b(mtd|ytd|lytd|lymtd|lmtd|weekly)\b/.test(searchLower);
      const metricsMatches = topMatches.filter((m) =>
        m.entry.title.toLowerCase().includes("scorecard metrics")
      );

      if (!hasPeriodKeyword && metricsMatches.length > 0) {
        // Determine if user wants a specific vertical or all
        const wantsIsprava = /\bisprava\b/.test(searchLower);
        const wantsChapter = /\bchapter\b/.test(searchLower);

        if (wantsIsprava || wantsChapter) {
          // Single vertical — pick the matching one
          const verticalMatch = metricsMatches.find((m) => {
            const titleLower = m.entry.title.toLowerCase();
            return wantsIsprava ? titleLower.includes("isprava") : titleLower.includes("chapter");
          });
          if (verticalMatch) {
            return await executeEntry(verticalMatch.entry, verticalMatch.score, {
              start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime,
            });
          }
        } else if (metricsMatches.length >= 2) {
          // No vertical specified — run both Isprava + Chapter, merge into single table
          const results = await Promise.all(
            metricsMatches.map((m) => {
              const vertical = m.entry.title.toLowerCase().includes("isprava") ? "Isprava" : "Chapter";
              return executeEntryRaw(m.entry, { start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime })
                .then((rows) => rows.map((row) => ({ vertical, ...row })));
            })
          );

          const mergedRows = results.flat();
          const rowCount = mergedRows.length;
          // If summarize_by is provided, return only the summary
          if (summarize_by) {
            const colExists = mergedRows.length > 0 && summarize_by in mergedRows[0];
            if (!colExists) {
              const availableCols = mergedRows.length > 0 ? Object.keys(mergedRows[0]) : [];
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: `Column "${summarize_by}" not found in query results.`,
                    available_columns: availableCols,
                  }, null, 2),
                }],
              };
            }
            const summary = buildSummaryTable(mergedRows, summarize_by);
            const responseText = `Query: Scorecard Dashboard (Isprava + Chapter) — Summary by ${summarize_by}\nRows: ${rowCount} rows summarized\n\nIMPORTANT: Present this table EXACTLY as shown below. These values are computed server-side. Do NOT modify, recalculate, or re-derive any values.\n\n${summary}`;
            return { content: [{ type: "text", text: responseText }] };
          }

          // Default: detail with offset-based pagination
          const pSize = page_size || 25;
          const startIdx = offset || 0;
          let displayRows = mergedRows;
          let pgInfo = "";
          if (rowCount > pSize) {
            const endIdx = Math.min(startIdx + pSize, rowCount);
            displayRows = mergedRows.slice(startIdx, endIdx);
            pgInfo = `\nShowing rows ${startIdx + 1}-${endIdx} of ${rowCount}.`;
            if (endIdx < rowCount) {
              pgInfo += ` To see the next rows, call this tool again with the same query, offset: ${endIdx}, and page_size: ${pSize}.`;
            }
          }

          const table = preformatTable(displayRows);
          const header = `**Scorecard Dashboard (Isprava + Chapter)**\nTotal rows: ${rowCount}${pgInfo}\n\n`;
          const footer = pgInfo ? `\n\n_Use offset parameter to see more rows._` : "";
          const responseText = `<<DIRECT_TABLE>>${header}${table}${footer}<<END_TABLE>>\nThe table above (${displayRows.length} rows) has been displayed directly to the user. Do NOT repeat or reproduce the table data. Instead, add a brief note: mention the total row count (${rowCount}), current page info, and ask if they want to see more rows, filter, or summarize.`;
          return { content: [{ type: "text", text: responseText }] };
        } else if (metricsMatches.length === 1) {
          // Only one metrics query matched
          return await executeEntry(metricsMatches[0].entry, metricsMatches[0].score, {
            start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime,
          });
        }
      }
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
      start_date, end_date, locations, exclude_locations, summarize_by, offset, page_size, startTime,
    });
  },
};

/** All predefined query tool plugins */
export const predefinedQueryPlugins: ToolPlugin[] = [runPredefinedQueryPlugin];
