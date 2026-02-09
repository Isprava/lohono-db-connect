import { z } from "zod";
import pg from "pg";
import {
  getFullContext,
  classifyIntent,
  getQueryTemplate,
  listQueryPatterns,
} from "./schema-rules.js";
import { analyzeQuery } from "./query-analyzer.js";
import { generateRules } from "./rule-generator.js";
import { RedashClient, parseQueryIds } from "./redash-client.js";
import { checkToolAccess } from "./acl.js";

const { Pool } = pg;

// ── Database pool ──────────────────────────────────────────────────────────

export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
});

// ── Zod schemas ────────────────────────────────────────────────────────────

const QueryInputSchema = z.object({
  sql: z.string().min(1, "SQL query cannot be empty"),
  params: z.array(z.unknown()).optional(),
});

const DescribeTableInputSchema = z.object({
  table_name: z.string().min(1, "Table name cannot be empty"),
  schema: z.string().optional().default("public"),
});

const ListTablesInputSchema = z.object({
  schema: z.string().optional().default("public"),
});

const ClassifyIntentInputSchema = z.object({
  question: z.string().min(1, "Question cannot be empty"),
});

const GetQueryTemplateInputSchema = z.object({
  pattern_name: z.string().min(1, "Pattern name cannot be empty"),
});

const AnalyzeQueryInputSchema = z.object({
  sql: z.string().min(1, "SQL query cannot be empty"),
});

const GenerateRulesInputSchema = z.object({
  sql: z.string().min(1, "SQL query cannot be empty"),
  pattern_name: z.string().min(1, "Pattern name cannot be empty"),
  description: z.string().min(1, "Description cannot be empty"),
  category: z.string().min(1, "Category cannot be empty"),
  intent_keywords: z.array(z.string()).optional(),
});

const FetchRedashQueryInputSchema = z.object({
  query_ids: z.string().min(1, "Query IDs cannot be empty"),
});

const GenerateRulesFromRedashInputSchema = z.object({
  query_ids: z.string().min(1, "Query IDs cannot be empty"),
  category: z.string().optional().default("custom"),
  intent_keywords: z.array(z.string()).optional(),
});

// ── Read-only query helper ─────────────────────────────────────────────────

async function executeReadOnlyQuery(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
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
  // ── Database tools ──
  {
    name: "query",
    description:
      "Run a read-only SQL query against the lohono_api_production PostgreSQL database. Use parameterized queries ($1, $2, ...) with the params array for user-supplied values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to execute (read-only)",
        },
        params: {
          type: "array",
          description:
            "Optional array of parameter values for parameterized queries",
          items: {},
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description:
      "List all tables in a given schema of the lohono_api_production database",
    inputSchema: {
      type: "object" as const,
      properties: {
        schema: {
          type: "string",
          description: 'Schema name (defaults to "public")',
        },
      },
    },
  },
  {
    name: "describe_table",
    description:
      "Get the column definitions, types, and constraints for a specific table",
    inputSchema: {
      type: "object" as const,
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to describe",
        },
        schema: {
          type: "string",
          description: 'Schema name (defaults to "public")',
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "list_schemas",
    description: "List all schemas in the database",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── Schema intelligence tools ──
  {
    name: "get_sales_funnel_context",
    description:
      "Get the complete sales funnel schema intelligence — core business rules, funnel stage definitions, date filter patterns, source mappings, anti-patterns, and validation checklist. Call this FIRST before writing any sales funnel SQL query to understand all mandatory rules.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "classify_sales_intent",
    description:
      "Classify a natural-language question about sales funnel data. Returns the matching query pattern(s), applicable business rules, date filters, and validation checks. Use this to determine WHICH query pattern to use before generating SQL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description:
            "The user's natural-language question about sales/funnel data",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "get_query_template",
    description:
      "Get the full rule set, date filters, funnel stages, metrics, special logic, and validation checks for a specific named query pattern. Available patterns: mtd_funnel_current, mtd_funnel_last_year, source_daily_breakdown, open_funnel_count, mtd_lead_details, prospect_aging, account_aging, historical_funnel_details, regional_closed_analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern_name: {
          type: "string",
          description:
            "Name of the query pattern (e.g. mtd_funnel_current, prospect_aging)",
        },
      },
      required: ["pattern_name"],
    },
  },
  {
    name: "list_query_patterns",
    description:
      "List all available sales funnel query patterns with their descriptions and intent keywords. Use this to discover which patterns exist.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── Query analysis & rule generation tools ──
  {
    name: "analyze_query",
    description:
      "Analyze a SQL query to extract its structural patterns — tables, joins, CTEs, aggregations, date filters, timezone conversions, exclusions, CASE statements, window functions, and more. Returns a detailed breakdown useful for understanding or generating rules.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to analyze",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "generate_rules",
    description:
      "Generate YAML business rules, an MCP tool definition, and a handler code snippet from a SQL query. Internally runs analyze_query first, then produces artifacts ready to add to the config and codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to generate rules from",
        },
        pattern_name: {
          type: "string",
          description:
            "Machine-readable name in snake_case (e.g. prospect_aging)",
        },
        description: {
          type: "string",
          description: "Human-readable description of the query",
        },
        category: {
          type: "string",
          description:
            "Category for the rule (e.g. mtd_aggregate, aging_reports)",
        },
        intent_keywords: {
          type: "array",
          description:
            "Optional list of natural-language keywords that should trigger this pattern",
          items: { type: "string" },
        },
      },
      required: ["sql", "pattern_name", "description", "category"],
    },
  },

  // ── Redash integration tools ──
  {
    name: "fetch_redash_query",
    description:
      "Fetch one or more SQL query definitions from Redash by query ID. Returns the SQL text, name, description, tags, and metadata for each query. Accepts a single ID or comma-separated IDs (e.g. '42' or '42,99,103').",
    inputSchema: {
      type: "object" as const,
      properties: {
        query_ids: {
          type: "string",
          description:
            "Redash query ID(s) — a single number or comma-separated list (e.g. '42' or '42,99,103')",
        },
      },
      required: ["query_ids"],
    },
  },
  {
    name: "generate_rules_from_redash",
    description:
      "Fetch SQL queries from Redash by ID, then analyze each and generate YAML rules, MCP tool definitions, and handler code. Combines fetch_redash_query + analyze_query + generate_rules in one step. Uses the Redash query name as pattern_name and description.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query_ids: {
          type: "string",
          description:
            "Redash query ID(s) — a single number or comma-separated list",
        },
        category: {
          type: "string",
          description:
            "Category for all generated rules (default: 'custom')",
        },
        intent_keywords: {
          type: "array",
          description:
            "Optional intent keywords to attach to all generated patterns",
          items: { type: "string" },
        },
      },
      required: ["query_ids"],
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

    // ── Database tools ──

    if (name === "query") {
      const { sql, params } = QueryInputSchema.parse(args);
      const result = await executeReadOnlyQuery(sql, params);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { rowCount: result.rowCount, rows: result.rows },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "list_tables") {
      const { schema } = ListTablesInputSchema.parse(args);
      const result = await executeReadOnlyQuery(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schema]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "describe_table") {
      const { table_name, schema } = DescribeTableInputSchema.parse(args);
      const result = await executeReadOnlyQuery(
        `SELECT
           c.column_name,
           c.data_type,
           c.character_maximum_length,
           c.is_nullable,
           c.column_default,
           tc.constraint_type
         FROM information_schema.columns c
         LEFT JOIN information_schema.key_column_usage kcu
           ON c.table_schema = kcu.table_schema
           AND c.table_name = kcu.table_name
           AND c.column_name = kcu.column_name
         LEFT JOIN information_schema.table_constraints tc
           ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY c.ordinal_position`,
        [schema, table_name]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    if (name === "list_schemas") {
      const result = await executeReadOnlyQuery(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY schema_name`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    }

    // ── Schema intelligence tools ──

    if (name === "get_sales_funnel_context") {
      const context = getFullContext();
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
      };
    }

    if (name === "classify_sales_intent") {
      const { question } = ClassifyIntentInputSchema.parse(args);
      const result = classifyIntent(question);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "get_query_template") {
      const { pattern_name } = GetQueryTemplateInputSchema.parse(args);
      const template = getQueryTemplate(pattern_name);
      if (!template) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown pattern: "${pattern_name}". Use list_query_patterns to see available patterns.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(template, null, 2) }],
      };
    }

    if (name === "list_query_patterns") {
      const patterns = listQueryPatterns();
      return {
        content: [{ type: "text", text: JSON.stringify(patterns, null, 2) }],
      };
    }

    // ── Query analysis & rule generation tools ──

    if (name === "analyze_query") {
      const { sql } = AnalyzeQueryInputSchema.parse(args);
      const analysis = analyzeQuery(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
      };
    }

    if (name === "generate_rules") {
      const input = GenerateRulesInputSchema.parse(args);
      const analysis = analyzeQuery(input.sql);
      const output = generateRules({
        sql: input.sql,
        analysis,
        pattern_name: input.pattern_name,
        description: input.description,
        category: input.category,
        intent_keywords: input.intent_keywords,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }

    // ── Redash integration tools ──

    if (name === "fetch_redash_query") {
      const { query_ids } = FetchRedashQueryInputSchema.parse(args);
      const ids = parseQueryIds(query_ids);
      const client = new RedashClient();
      const results = await client.fetchQueries(ids);

      const output = results.map((r) => {
        if (!r.success || !r.query) {
          return { id: r.id, success: false, error: r.error };
        }
        const q = r.query;
        return {
          id: q.id,
          success: true,
          name: q.name,
          description: q.description,
          sql: q.query,
          tags: q.tags,
          data_source_id: q.data_source_id,
          created_at: q.created_at,
          updated_at: q.updated_at,
          user: q.user,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }

    if (name === "generate_rules_from_redash") {
      const input = GenerateRulesFromRedashInputSchema.parse(args);
      const ids = parseQueryIds(input.query_ids);
      const client = new RedashClient();
      const fetched = await client.fetchQueries(ids);

      const outputs = [];
      for (const r of fetched) {
        if (!r.success || !r.query) {
          outputs.push({ id: r.id, success: false, error: r.error });
          continue;
        }
        const q = r.query;
        const patternName = q.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const analysis = analyzeQuery(q.query);
        const generated = generateRules({
          sql: q.query,
          analysis,
          pattern_name: patternName,
          description: q.description || q.name,
          category: input.category,
          intent_keywords: input.intent_keywords,
        });
        outputs.push({
          id: q.id,
          success: true,
          redash_name: q.name,
          pattern_name: patternName,
          ...generated,
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(outputs, null, 2) }],
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
