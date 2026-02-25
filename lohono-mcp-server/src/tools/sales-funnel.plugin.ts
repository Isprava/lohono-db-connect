import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import {
  buildSalesFunnelQuery,
  buildOrderbookDetailQuery,
  getFunnelConfig,
} from "../sales-funnel-builder.js";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";
import { Vertical, DEFAULT_VERTICAL, getVerticalOrDefault } from "../../../shared/types/verticals.js";

// ── Build dynamic metric enum from YAML config ─────────────────────────────

const funnelConfig = getFunnelConfig();
const metricKeys = Object.keys(funnelConfig.funnel_stages);  // e.g. ["lead", "prospect", "account", "sale"]
const metricEnum = ["all", ...metricKeys] as const;

// ── Input schema ────────────────────────────────────────────────────────────

const GetSalesFunnelInputSchema = z.object({
  start_date: z.string().min(1, "Start date cannot be empty"),
  end_date: z.string().min(1, "End date cannot be empty"),
  metric: z.enum(metricEnum).optional().default("all"),
  vertical: z.nativeEnum(Vertical).optional().default(DEFAULT_VERTICAL),
  locations: z.array(z.string()).optional(),
});

// ── Query result cache (Redis-backed with in-memory fallback) ───────────────

interface CacheEntry {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const HISTORICAL_TTL = 86_400; // 24 hours — past data doesn't change
const CURRENT_TTL = 60;       // 60 seconds — current month data is live

const queryCache = new RedisCache<CacheEntry>("query:funnel", CURRENT_TTL);

/** Returns true if the entire date range falls before the current month in IST. */
function isHistoricalRange(endDate: string): boolean {
  // IST is UTC+5:30 — compute the first day of the current month in IST
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffsetMs);
  const startOfMonthIst = new Date(nowIst.getFullYear(), nowIst.getMonth(), 1);
  const endParsed = new Date(endDate + "T00:00:00");
  return endParsed < startOfMonthIst;
}

// ── Debug mode ───────────────────────────────────────────────────────────────

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// ── Build tool description with metric names from config ────────────────────

const metricDescriptions = Object.entries(funnelConfig.funnel_stages)
  .sort(([, a], [, b]) => a.sort_order - b.sort_order)
  .map(([key, stage]) => `'${key}' = ${stage.metric_name}`)
  .join(", ");

// ── Plugin ──────────────────────────────────────────────────────────────────

export const getSalesFunnelPlugin: ToolPlugin = {
  definition: {
    name: "get_sales_funnel",
    description:
      `MANDATORY TOOL for sales funnel metrics. Get sales funnel data for ANY date range. ` +
      `Use the 'metric' parameter to select a specific metric (${metricDescriptions}) or omit it / use 'all' for the full funnel. ` +
      `CRITICAL: This is the ONLY correct way to query sales funnel metrics. ` +
      `DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. ` +
      `NOTE: For orderbook breakdown by location/property_type with amount_cr and units_sold, use the 'get_orderbook' tool instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (e.g. '2026-01-01')" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (e.g. '2026-01-31')" },
        metric: {
          type: "string",
          enum: metricEnum,
          description: `Which metric to return. Options: ${metricEnum.join(", ")}. Default 'all' returns the full funnel.`,
        },
        vertical: {
          type: "string",
          description: "Business vertical (isprava, lohono_stays, the_chapter, solene). Defaults to 'isprava' if not specified.",
          enum: ["isprava", "lohono_stays", "the_chapter", "solene"],
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of locations to filter by (e.g. ['Goa', 'Alibaug']). Fuzzy matching is applied.",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  async handler(args): Promise<ToolResult> {
    const { start_date, end_date, metric, vertical, locations } = GetSalesFunnelInputSchema.parse(args);
    const validVertical = getVerticalOrDefault(vertical);
    const metricKey = metric === "all" ? undefined : metric;
    const startTime = Date.now();

    // Build query (needed for execution and debug info)
    const query = buildSalesFunnelQuery(validVertical, locations, metricKey);
    const allParams = [start_date, end_date, ...query.params];

    // Cache key
    const cacheKey = `funnel:${start_date}:${end_date}:${metric}:${validVertical}:${(locations || []).sort().join(",")}`;
    const cached = await queryCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      const responseData: Record<string, unknown> = {
        start_date, end_date, metric, vertical: validVertical, locations,
        rowCount: cached.rowCount, metrics: cached.rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "get_sales_funnel",
          cacheHit: true,
          cacheKey,
          sql: query.sql,
          params: allParams,
          executionMs: Date.now() - startTime,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
      };
    }
    const result = await executeReadOnlyQuery(query.sql, allParams);

    // Cache — historical date ranges get a 24h TTL, current month gets 60s
    const rows = result.rows as Record<string, unknown>[];
    const ttl = isHistoricalRange(end_date) ? HISTORICAL_TTL : CURRENT_TTL;
    await queryCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

    const responseData: Record<string, unknown> = {
      start_date, end_date, metric, vertical: validVertical, locations,
      rowCount: result.rowCount, metrics: rows,
    };
    if (DEBUG_MODE) {
      responseData._debug = {
        tool: "get_sales_funnel",
        cacheHit: false,
        sql: query.sql,
        params: allParams,
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

// ── Orderbook detail plugin ──────────────────────────────────────────────────

const GetOrderbookInputSchema = z.object({
  start_date: z.string().min(1, "Start date cannot be empty"),
  end_date: z.string().min(1, "End date cannot be empty"),
  vertical: z.nativeEnum(Vertical).optional().default(DEFAULT_VERTICAL),
  locations: z.array(z.string()).optional(),
});

const orderbookCache = new RedisCache<CacheEntry>("query:orderbook", CURRENT_TTL);

export const getOrderbookPlugin: ToolPlugin = {
  definition: {
    name: "get_orderbook",
    description:
      `MANDATORY TOOL for orderbook queries. ` +
      `Use this tool whenever the user mentions ANY of the following: ` +
      `"orderbook", "order book", "orderbook actuals", "orderbook breakdown", ` +
      `"orderbook by property type", "orderbook by location", "orderbook for Isprava", ` +
      `"orderbook Goa", "orderbook Villa", "orderbook actuals Isprava", ` +
      `"orderbook Chapter", "Chapter orderbook", "orderbook for Chapter", ` +
      `"outbook Chapter", "Chapter outbook", or any variation thereof. ` +
      `Returns a detailed breakdown of booked sales grouped by location and property type ` +
      `(Vaddo, Villa, Estate, Chapter) with amount in Crore (amount_cr) and units_sold. ` +
      `Date range filters on maal_laao_at with IST timezone correction (+330 minutes). ` +
      `Fixed reference slugs (d-ref-a2ff7f98, 7A5D8F55) are always included for Isprava; ` +
      `d-ref-a2ff7f98 is always included for Chapter. ` +
      `When the user mentions Chapter, pass vertical='the_chapter' — this triggers the Chapter-specific query. ` +
      `DO NOT use get_sales_funnel for orderbook queries — use this tool instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (e.g. '2026-01-01')" },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (e.g. '2026-12-31')" },
        vertical: {
          type: "string",
          description: "Business vertical (isprava, lohono_stays, the_chapter, solene). Defaults to 'isprava' if not specified.",
          enum: ["isprava", "lohono_stays", "the_chapter", "solene"],
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of locations to filter by (e.g. ['Goa', 'Alibaug']). Fuzzy matching is applied.",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  async handler(args): Promise<ToolResult> {
    const { start_date, end_date, vertical, locations } = GetOrderbookInputSchema.parse(args);
    const validVertical = getVerticalOrDefault(vertical);
    const startTime = Date.now();

    const query = buildOrderbookDetailQuery(validVertical, locations);
    const allParams = [start_date, end_date, ...query.params];

    const cacheKey = `orderbook:${start_date}:${end_date}:${validVertical}:${(locations || []).sort().join(",")}`;
    const cached = await orderbookCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      const responseData: Record<string, unknown> = {
        start_date, end_date, vertical: validVertical, locations,
        rowCount: cached.rowCount, rows: cached.rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "get_orderbook", cacheHit: true, cacheKey,
          sql: query.sql, params: allParams, executionMs: Date.now() - startTime,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
    }

    const result = await executeReadOnlyQuery(query.sql, allParams);
    const rows = result.rows as Record<string, unknown>[];
    const ttl = isHistoricalRange(end_date) ? HISTORICAL_TTL : CURRENT_TTL;
    await orderbookCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

    const responseData: Record<string, unknown> = {
      start_date, end_date, vertical: validVertical, locations,
      rowCount: result.rowCount, rows,
    };
    if (DEBUG_MODE) {
      responseData._debug = {
        tool: "get_orderbook", cacheHit: false,
        sql: query.sql, params: allParams, ttl,
        rowCount: result.rowCount, executionMs: Date.now() - startTime,
      };
    }

    return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
  },
};

// ── Chapter Scorecard plugin (MTD / YTD / LYTD / LYMTD) ─────────────────────

import {
  buildChapterFunnelQuery,
} from "../chapter-funnel-builder.js";

/** Compute MTD, YTD, LYTD, or LYMTD start/end strings in IST (UTC+5:30).
 *
 * MTD   = first day of current month → today
 * YTD   = Jan 1 current year         → today
 * LYTD  = Jan 1 last year            → same month/day last year  (Last Year to Date)
 * LYMTD = first day of same month last year → same day last year
 */
function getChapterScorecardDates(period: "mtd" | "ytd" | "lytd" | "lymtd"): {
  start: string;
  end: string;
  label: string;
} {
  const istMs = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + istMs);

  const year = nowIST.getUTCFullYear();
  const month = String(nowIST.getUTCMonth() + 1).padStart(2, "0");
  const day = String(nowIST.getUTCDate()).padStart(2, "0");
  const today = `${year}-${month}-${day}`;

  if (period === "mtd") {
    // first day of current month → today
    return { start: `${year}-${month}-01`, end: today, label: "MTD" };
  }
  if (period === "ytd") {
    return { start: `${year}-01-01`, end: today, label: "YTD" };
  }
  if (period === "lytd") {
    // Jan 1 of last year → today (Last Year to Date)
    return { start: `${year - 1}-01-01`, end: today, label: "LYTD" };
  }
  // lymtd: first day of same month last year → same day last year
  return {
    start: `${year - 1}-${month}-01`,
    end: `${year - 1}-${month}-${day}`,
    label: "LYMT",
  };
}

/** Map SQL metric names → camelCase scorecard keys. */
const METRIC_NAME_TO_KEY: Record<string, string> = {
  Viewings: "viewings",
  Meetings: "meetings",
  "12P": "l2p",
  P2A: "p2a",
  A2S: "a2s",
  Leads: "leads",
  Prospects: "prospects",
  Accounts: "accounts",
  Sales: "sales",
};

/** Pivot tall rows → single wide scorecard object. */
function pivotToScorecard(
  rows: Record<string, unknown>[],
): Record<string, number> {
  const scorecard: Record<string, number> = {};
  for (const row of rows) {
    const key = METRIC_NAME_TO_KEY[row.metric as string];
    if (key !== undefined) {
      scorecard[key] = (row.count as number) ?? 0;
    }
  }
  return scorecard;
}

const GetChapterScorecardInputSchema = z.object({
  period: z.enum(["mtd", "ytd", "lytd", "lymtd"]).optional().default("ytd"),
  locations: z.array(z.string()).optional(),
});

const scorecardCache = new RedisCache<CacheEntry>("query:chapter-scorecard", CURRENT_TTL);

export const getChapterScorecardPlugin: ToolPlugin = {
  definition: {
    name: "get_chapter_scorecard",
    description:
      `MANDATORY TOOL for Chapter MTD, YTD, LYTD, and LYMTD scorecard requests. ` +
      `Use this tool whenever the user mentions ANY of the following: ` +
      `"MTD", "YTD", "LYTD", "LYMTD", "MTD Scorecard", "YTD Scorecard", "LYTD Scorecard", "LYMTD Scorecard", ` +
      `"Month-to-date scorecard", "Year-to-date scorecard", "Last year month to date", ` +
      `"chapter scorecard", "chapter MTD", "chapter YTD", "chapter LYTD", "chapter LYMTD", ` +
      `"chapter year to date", "chapter month to date", "get MTD", "get LYTD", "get LYMTD", or any variation thereof. ` +
      `This tool automatically computes the correct IST date range — no dates needed from the user. ` +
      `Returns a single wide scorecard row with all 9 Chapter metrics as columns: ` +
      `viewings, meetings, l2p (12P), p2a, a2s, leads, prospects, accounts, sales. ` +
      `Use period='mtd' for current month-to-date, period='ytd' for current year-to-date, ` +
      `period='lytd' for last year to today, period='lymtd' for same month last year. ` +
      `DO NOT use get_sales_funnel for scorecard requests — use this tool instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["mtd", "ytd", "lytd", "lymtd"],
          description:
            "'mtd' = first day of current month to today (IST). " +
            "'ytd' = Jan 1 of current year to today (IST). " +
            "'lytd' = Jan 1 of last year to today (IST). " +
            "'lymtd' = first day of same month last year to same day last year (IST). Default: 'ytd'.",
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional location filter (e.g. ['Goa', 'Alibaug']). Fuzzy matching applied.",
        },
      },
      required: [],
    },
  },

  async handler(args): Promise<ToolResult> {
    const { period, locations } = GetChapterScorecardInputSchema.parse(args);
    const startTime = Date.now();

    const { start, end, label } = getChapterScorecardDates(period);
    const cacheKey = `chapter-scorecard:${period}:${start}:${end}:${(locations || []).sort().join(",")}`;
    const cached = await scorecardCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      const scorecard = pivotToScorecard(cached.rows);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: label, start_date: start, end_date: end, locations,
            scorecard,
          }, null, 2),
        }],
      };
    }

    const query = buildChapterFunnelQuery(locations);
    const allParams = [start, end, ...query.params];

    const result = await executeReadOnlyQuery(query.sql, allParams);
    const rows = result.rows as Record<string, unknown>[];
    const ttl = isHistoricalRange(end) ? HISTORICAL_TTL : CURRENT_TTL;
    await scorecardCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

    const scorecard = pivotToScorecard(rows);

    const responseData: Record<string, unknown> = {
      period: label, start_date: start, end_date: end, locations,
      scorecard,
    };
    if (DEBUG_MODE) {
      responseData._debug = {
        tool: "get_chapter_scorecard",
        cacheHit: false,
        sql: query.sql,
        params: allParams,
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

/** All sales funnel tool plugins */
export const salesFunnelPlugins: ToolPlugin[] = [
  getSalesFunnelPlugin,
  getOrderbookPlugin,
  getChapterScorecardPlugin,
];
