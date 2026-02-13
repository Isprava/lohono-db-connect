import { z } from "zod";
import pg from "pg";
import { logger } from "../../shared/observability/src/logger.js";
import { checkToolAccess } from "./acl.js";
import {
  buildSalesFunnelQuery,
  buildLeadsQuery,
  buildProspectsQuery,
  buildAccountsQuery,
  buildSalesQuery,
} from "./sales-funnel-builder.js";

const { Pool } = pg;

// ── Database pool ──────────────────────────────────────────────────────────

const dbHost = process.env.DB_HOST || "localhost";

const pgConfig = {
  host: dbHost,
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
  ssl:
    process.env.DB_SSL === "false" || dbHost === "localhost"
      ? false
      : { rejectUnauthorized: false },
};

logger.info("Initializing PG pool", {
  host: pgConfig.host,
  port: pgConfig.port,
  user: pgConfig.user,
  database: pgConfig.database,
});

export const pool = new Pool(pgConfig);

pool.on("connect", (client) => {
  logger.info("PG pool: new client connected", {
    host: pgConfig.host,
    database: pgConfig.database,
  });
});

pool.on("error", (err) => {
  logger.error("PG pool: unexpected error on idle client", {
    error: err.message,
  });
});

// ── Zod schemas ────────────────────────────────────────────────────────────

const GetSalesFunnelInputSchema = z.object({
  start_date: z.string().min(1, "Start date cannot be empty"),
  end_date: z.string().min(1, "End date cannot be empty"),
});

// ── Read-only query helper ───────────────────────────────────────────

async function executeReadOnlyQuery(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ── Tool definitions (JSON Schema for MCP) ─────────────────────────────────

export const toolDefinitions = [
  {
    name: "get_sales_funnel",
    description:
      "MANDATORY TOOL for sales funnel metrics. Get sales funnel data (Leads, Prospects, Accounts, Sales) for ANY date range. CRITICAL: This is the ONLY correct way to query sales funnel metrics.  User asks for 'sales for January'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format (e.g. '2026-01-01')",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format (e.g. '2026-01-31')",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "get_leads",
    description: "Get only Leads count for a date range. User asks for 'leads'? Use this tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "get_prospects",
    description: "Get only Prospects count for a date range. User asks for 'prospects'? Use this tool.DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "get_accounts",
    description: "Get only Accounts count for a date range. User asks for 'accounts'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "get_sales",
    description: "Get only Sales count for a date range. User asks for 'sales'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
];

// ── Tool handler ───────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  userEmail?: string
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    // ── ACL enforcement ──
    const aclResult = await checkToolAccess(name, userEmail, pool);
    if (!aclResult.allowed) {
      return {
        content: [
          {
            type: "text",
            text: `Access denied: ${aclResult.reason}`,
          },
        ],
        isError: true,
      };
    }

    if (name === "get_sales_funnel") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      const sql = buildSalesFunnelQuery();
      const result = await executeReadOnlyQuery(sql, [start_date, end_date]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                start_date,
                end_date,
                rowCount: result.rowCount,
                metrics: result.rows
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_leads") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      const sql = buildLeadsQuery();
      const result = await executeReadOnlyQuery(sql, [start_date, end_date]);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "get_prospects") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      const sql = buildProspectsQuery();
      const result = await executeReadOnlyQuery(sql, [start_date, end_date]);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "get_accounts") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      const sql = buildAccountsQuery();
      const result = await executeReadOnlyQuery(sql, [start_date, end_date]);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "get_sales") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      const sql = buildSalesQuery();
      const result = await executeReadOnlyQuery(sql, [start_date, end_date]);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Validation error: ${error.issues.map((e) => e.message).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
