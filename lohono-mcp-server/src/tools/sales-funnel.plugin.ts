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

const queryCache = new RedisCache<CacheEntry>("query:funnel", 60); // 60 seconds TTL

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

    // Cache key
    const cacheKey = `funnel:${start_date}:${end_date}:${metric}:${validVertical}:${(locations || []).sort().join(",")}`;
    const cached = await queryCache.get(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ start_date, end_date, metric, vertical: validVertical, locations, rowCount: cached.rowCount, metrics: cached.rows }, null, 2),
        }],
      };
    }

    // Build and execute query
    const query = buildSalesFunnelQuery(validVertical, locations, metricKey);
    const result = await executeReadOnlyQuery(query.sql, [start_date, end_date, ...query.params]);

    // Cache
    const rows = result.rows as Record<string, unknown>[];
    await queryCache.set(cacheKey, { rows, rowCount: result.rowCount });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ start_date, end_date, metric, vertical: validVertical, locations, rowCount: result.rowCount, metrics: rows }, null, 2),
      }],
    };
  },
};

/** All sales funnel tool plugins */
export const salesFunnelPlugins: ToolPlugin[] = [getSalesFunnelPlugin];
