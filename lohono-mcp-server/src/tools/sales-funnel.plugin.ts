import { z } from "zod";
import { executeReadOnlyQuery } from "../db/pool.js";
import {
  buildSalesFunnelQuery,
  buildLeadsQuery,
  buildProspectsQuery,
  buildAccountsQuery,
  buildSalesQuery,
} from "../sales-funnel-builder.js";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";

// ── Shared input schema ─────────────────────────────────────────────────────

const DateRangeSchema = z.object({
  start_date: z.string().min(1, "Start date cannot be empty"),
  end_date: z.string().min(1, "End date cannot be empty"),
});

const dateRangeInputSchema = {
  type: "object" as const,
  properties: {
    start_date: { type: "string", description: "Start date in YYYY-MM-DD format (e.g. '2026-01-01')" },
    end_date: { type: "string", description: "End date in YYYY-MM-DD format (e.g. '2026-01-31')" },
  },
  required: ["start_date", "end_date"],
};

// ── Query result cache (Redis-backed with in-memory fallback) ───────────────

interface CacheEntry {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

const queryCache = new RedisCache<CacheEntry>("query:funnel", 60); // 60 seconds TTL

// ── Helper: run a parameterized funnel query (with caching) ─────────────────

async function runFunnelQuery(
  toolName: string,
  builderFn: () => { sql: string; params: unknown[] },
  args: Record<string, unknown> | undefined
): Promise<{ start_date: string; end_date: string; rows: Record<string, unknown>[]; rowCount: number | null }> {
  const { start_date, end_date } = DateRangeSchema.parse(args);

  // Check cache
  const cacheKey = `${toolName}:${start_date}:${end_date}`;
  const cached = await queryCache.get(cacheKey);
  if (cached) {
    logger.info(`Cache hit: ${cacheKey}`);
    return { start_date, end_date, rows: cached.rows, rowCount: cached.rowCount };
  }

  // Execute query
  const query = builderFn();
  const result = await executeReadOnlyQuery(query.sql, [start_date, end_date, ...query.params]);

  // Cache result
  const rows = result.rows as Record<string, unknown>[];
  await queryCache.set(cacheKey, { rows, rowCount: result.rowCount });

  return { start_date, end_date, rows, rowCount: result.rowCount };
}

// ── Plugins ─────────────────────────────────────────────────────────────────

export const getSalesFunnelPlugin: ToolPlugin = {
  definition: {
    name: "get_sales_funnel",
    description:
      "MANDATORY TOOL for sales funnel metrics. Get sales funnel data (Leads, Prospects, Accounts, Sales) for ANY date range. CRITICAL: This is the ONLY correct way to query sales funnel metrics.  User asks for 'sales for January'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: dateRangeInputSchema,
  },
  async handler(args): Promise<ToolResult> {
    const { start_date, end_date, rows, rowCount } = await runFunnelQuery("get_sales_funnel", buildSalesFunnelQuery, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ start_date, end_date, rowCount, metrics: rows }, null, 2),
      }],
    };
  },
};

export const getLeadsPlugin: ToolPlugin = {
  definition: {
    name: "get_leads",
    description: "Get only Leads count for a date range. User asks for 'leads'? Use this tool.",
    inputSchema: dateRangeInputSchema,
  },
  async handler(args): Promise<ToolResult> {
    const { rows } = await runFunnelQuery("get_leads", buildLeadsQuery, args);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
};

export const getProspectsPlugin: ToolPlugin = {
  definition: {
    name: "get_prospects",
    description: "Get only Prospects count for a date range. User asks for 'prospects'? Use this tool.DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: dateRangeInputSchema,
  },
  async handler(args): Promise<ToolResult> {
    const { rows } = await runFunnelQuery("get_prospects", buildProspectsQuery, args);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
};

export const getAccountsPlugin: ToolPlugin = {
  definition: {
    name: "get_accounts",
    description: "Get only Accounts count for a date range. User asks for 'accounts'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: dateRangeInputSchema,
  },
  async handler(args): Promise<ToolResult> {
    const { rows } = await runFunnelQuery("get_accounts", buildAccountsQuery, args);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
};

export const getSalesPlugin: ToolPlugin = {
  definition: {
    name: "get_sales",
    description: "Get only Sales count for a date range. User asks for 'sales'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: dateRangeInputSchema,
  },
  async handler(args): Promise<ToolResult> {
    const { rows } = await runFunnelQuery("get_sales", buildSalesQuery, args);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
};

/** All sales funnel tool plugins */
export const salesFunnelPlugins: ToolPlugin[] = [
  getSalesFunnelPlugin,
  getLeadsPlugin,
  getProspectsPlugin,
  getAccountsPlugin,
  getSalesPlugin,
];
