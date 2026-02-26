import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import {
  buildSalesFunnelQuery,
  getFunnelConfig,
} from "../sales-funnel-builder.js";
import { buildConsolidatedScorecardQuery } from "../consolidated-scorecard-builder.js";
import { buildAgeingAnalysisQuery } from "../ageing-analysis-builder.js";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";
import { Vertical, DEFAULT_VERTICAL, getVerticalOrDefault } from "../../../shared/types/verticals.js";

// ── Build dynamic metric enum from YAML config ─────────────────────────────

const funnelConfig = getFunnelConfig();
const metricKeys = Object.keys(funnelConfig.funnel_stages);  // e.g. ["lead", "prospect", "account", "sale"]
const metricEnum = ["all", ...metricKeys, "consolidated_scorecard", "ageing_analysis"] as const;

// ── Input schema ────────────────────────────────────────────────────────────
// start_date / end_date are optional to support consolidated_scorecard which
// auto-computes its own Indian FY date boundaries.

const GetSalesFunnelInputSchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  metric: z.enum(metricEnum).optional().default("all"),
  vertical: z.nativeEnum(Vertical).optional().default(DEFAULT_VERTICAL),
  locations: z.array(z.string()).optional(),
}).refine(
  (d) => d.metric === "ageing_analysis" || (!!d.start_date && !!d.end_date),
  { message: "start_date and end_date are required (not needed for ageing_analysis)" },
);

// ── Query result cache (Redis-backed with in-memory fallback) ───────────────

interface CacheEntry {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const HISTORICAL_TTL = 86_400; // 24 hours — past data doesn't change
const CURRENT_TTL = 60;       // 60 seconds — current month data is live

const queryCache = new RedisCache<CacheEntry>("query:funnel", CURRENT_TTL);
const consolidatedCache = new RedisCache<CacheEntry>("query:consolidated-scorecard", CURRENT_TTL);
const ageingCache = new RedisCache<CacheEntry>("query:ageing-analysis", CURRENT_TTL);

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
      `MANDATORY TOOL for sales funnel metrics, consolidated dashboard scorecard, and ageing analysis. ` +
      `Use the 'metric' parameter to select a specific metric (${metricDescriptions}) or omit it / use 'all' for the full funnel. ` +
      `For Consolidated Dashboard / Consolidated Scorecard requests — use metric='consolidated_scorecard' with start_date and end_date. ` +
      `For Ageing Analysis / Ageing Analysis - Consolidated Dashboard Query — use metric='ageing_analysis'. No dates needed; it is a current-state snapshot. ` +
      `CRITICAL: This is the ONLY correct way to query sales funnel or post-sales metrics. ` +
      `DO NOT write custom SQL queries — the logic is complex and already implemented correctly in this tool.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date in YYYY-MM-DD format (e.g. '2025-04-01')." },
        end_date: { type: "string", description: "End date in YYYY-MM-DD format (e.g. '2026-02-28')." },
        metric: {
          type: "string",
          enum: metricEnum,
          description: `Which metric to return. Options: ${metricEnum.join(", ")}. Default 'all' returns the full funnel. Use 'consolidated_scorecard' for the Consolidated Dashboard (requires start_date and end_date). Use 'ageing_analysis' for the Ageing Analysis Dashboard (no dates needed — current snapshot).`,
        },
        vertical: {
          type: "string",
          description: "Business vertical (isprava, lohono_stays, the_chapter, solene). Defaults to 'isprava'. Not applicable for consolidated_scorecard (covers all verticals).",
          enum: ["isprava", "lohono_stays", "the_chapter", "solene"],
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of locations to filter by (e.g. ['Goa', 'Alibaug']). Fuzzy matching is applied.",
        },
      },
      required: [],
    },
  },
  async handler(args): Promise<ToolResult> {
    const parsed = GetSalesFunnelInputSchema.parse(args);
    const { metric, vertical, locations } = parsed;
    const startTime = Date.now();

    // ── Ageing Analysis path ────────────────────────────────────────────────
    if (metric === "ageing_analysis") {
      const cacheKey = `ageing:${(locations || []).sort().join(",")}`;
      const cached = await ageingCache.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit: ${cacheKey}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              metric: "ageing_analysis", locations,
              rowCount: cached.rowCount, rows: cached.rows,
            }, null, 2),
          }],
        };
      }
      const query = buildAgeingAnalysisQuery(locations);
      const result = await executeReadOnlyQuery(query.sql, []);
      const rows = result.rows as Record<string, unknown>[];
      await ageingCache.set(cacheKey, { rows, rowCount: result.rowCount }, CURRENT_TTL);
      const responseData: Record<string, unknown> = {
        metric: "ageing_analysis", locations,
        rowCount: result.rowCount, rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "get_sales_funnel", metric: "ageing_analysis",
          cacheHit: false, sql: query.sql,
          rowCount: result.rowCount, executionMs: Date.now() - startTime,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
    }

    // ── Consolidated Scorecard path ─────────────────────────────────────────
    if (metric === "consolidated_scorecard") {
      const start_date = parsed.start_date!;
      const end_date = parsed.end_date!;
      const cacheKey = `consolidated:${start_date}:${end_date}:${(locations || []).sort().join(",")}`;
      const cached = await consolidatedCache.get(cacheKey);
      if (cached) {
        logger.info(`Cache hit: ${cacheKey}`);
        const responseData: Record<string, unknown> = {
          metric: "consolidated_scorecard",
          start_date, end_date, locations,
          rowCount: cached.rowCount,
          rows: cached.rows,
        };
        return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
      }

      const query = buildConsolidatedScorecardQuery(start_date, end_date, locations);
      const result = await executeReadOnlyQuery(query.sql, []);
      const rows = result.rows as Record<string, unknown>[];
      const ttl = isHistoricalRange(end_date) ? HISTORICAL_TTL : CURRENT_TTL;
      await consolidatedCache.set(cacheKey, { rows, rowCount: result.rowCount }, ttl);

      const responseData: Record<string, unknown> = {
        metric: "consolidated_scorecard",
        start_date, end_date, locations,
        rowCount: result.rowCount,
        rows,
      };
      if (DEBUG_MODE) {
        responseData._debug = {
          tool: "get_sales_funnel",
          metric: "consolidated_scorecard",
          cacheHit: false,
          sql: query.sql,
          rowCount: result.rowCount,
          executionMs: Date.now() - startTime,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] };
    }

    // ── Regular sales funnel path ───────────────────────────────────────────
    const start_date = parsed.start_date!;
    const end_date = parsed.end_date!;
    const validVertical = getVerticalOrDefault(vertical);
    const metricKey = metric === "all" ? undefined : metric;

    const query = buildSalesFunnelQuery(validVertical, locations, metricKey);
    const allParams = [start_date, end_date, ...query.params];

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

/** All sales funnel tool plugins */
export const salesFunnelPlugins: ToolPlugin[] = [getSalesFunnelPlugin];
