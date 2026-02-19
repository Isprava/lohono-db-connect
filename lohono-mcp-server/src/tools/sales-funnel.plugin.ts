import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import {
  buildSalesFunnelQuery,
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
      `DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool.`,
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

/** All sales funnel tool plugins */
export const salesFunnelPlugins: ToolPlugin[] = [getSalesFunnelPlugin];
