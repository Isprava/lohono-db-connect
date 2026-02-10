import { z } from "zod";
import pg from "pg";
import {
  loadDatabaseCatalog,
  loadForeignKeysCatalog,
  getTableDefinition,
  searchTables,
  getTableRelationships,
  getTablesSummary,
  getSchemaContext,
  findTablesByColumn,
  getRelationshipChain,
  getCatalogMetadata,
} from "./database-catalog.js";
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

const GetTableSchemaInputSchema = z.object({
  table_name: z.string().min(1, "Table name cannot be empty"),
});

const SearchTablesInputSchema = z.object({
  pattern: z.string().min(1, "Search pattern cannot be empty"),
});

const GetTableRelationshipsInputSchema = z.object({
  table_name: z.string().min(1, "Table name cannot be empty"),
});

const GetSchemaContextInputSchema = z.object({
  table_names: z.array(z.string()).min(1, "Must provide at least one table name"),
});

const FindTablesByColumnInputSchema = z.object({
  column_name: z.string().min(1, "Column name cannot be empty"),
});

const GetRelationshipChainInputSchema = z.object({
  start_table: z.string().min(1, "Start table cannot be empty"),
  max_depth: z.number().int().min(1).max(5).optional().default(2),
});

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
  // ── Database tools ──
  // NOTE: Generic 'query' tool has been removed. Use specialized tools like 'get_sales_funnel' instead.
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

  // ── Database catalog tools ──
  {
    name: "get_catalog_metadata",
    description:
      "Get metadata about the database catalog files — paths, existence, counts. Use this to verify catalog availability.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_tables_summary",
    description:
      "Get a summary of all tables in the database with their column counts, sorted by size. Useful for discovering available tables.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_table_schema",
    description:
      "Get the complete schema definition for a specific table from the catalog — all columns with types, constraints, defaults. This reads from the pre-built catalog (faster than describe_table).",
    inputSchema: {
      type: "object" as const,
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to get schema for",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "search_tables",
    description:
      "Search for tables by name pattern (case-insensitive substring match). Returns full table definitions for all matching tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (substring, e.g. 'opportunity', 'enquir')",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "get_table_relationships",
    description:
      "Get all foreign key relationships for a specific table — both outgoing (this table references others) and incoming (other tables reference this table). Includes join examples and business context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        table_name: {
          type: "string",
          description: "Name of the table to get relationships for",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "get_schema_context",
    description:
      "Get complete schema context for SQL generation — table definitions and foreign key relationships for multiple tables. Use this when you need detailed schema info for query construction.",
    inputSchema: {
      type: "object" as const,
      properties: {
        table_names: {
          type: "array",
          description: "List of table names to get context for",
          items: { type: "string" },
        },
      },
      required: ["table_names"],
    },
  },
  {
    name: "find_tables_by_column",
    description:
      "Find all tables that have a specific column name. Useful for discovering which tables contain a particular field.",
    inputSchema: {
      type: "object" as const,
      properties: {
        column_name: {
          type: "string",
          description: "Column name to search for (e.g. 'agent_id', 'deleted_at')",
        },
      },
      required: ["column_name"],
    },
  },
  {
    name: "get_relationship_chain",
    description:
      "Get all tables connected through foreign key relationships starting from a specific table, up to a maximum depth. Returns a list of related table names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_table: {
          type: "string",
          description: "Starting table name",
        },
        max_depth: {
          type: "number",
          description: "Maximum relationship depth to traverse (1-5, default: 2)",
        },
      },
      required: ["start_table"],
    },
  },
  {
    name: "get_sales_funnel",
    description:
      "MANDATORY TOOL for sales funnel metrics. Get sales funnel data (Leads, Prospects, Accounts, Sales) for ANY date range. CRITICAL: This is the ONLY correct way to query sales funnel metrics. User asks for 'leads'? Use this tool. User asks for 'prospects'? Use this tool. User asks for 'sales for January'? Use this tool. DO NOT write custom SQL queries for sales funnel data - the logic is complex (IST timezone +330min, multiple source tables with UNION, exclusions, window functions) and already implemented correctly in this tool. Returns all 4 metrics in one call with proper calculation from development_opportunities, enquiries, stage_histories, and tasks tables.",
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
    // NOTE: 'query' tool handler removed - use specialized tools instead

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

    // ── Database catalog tools ──

    if (name === "get_catalog_metadata") {
      const metadata = getCatalogMetadata();
      return {
        content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }],
      };
    }

    if (name === "get_tables_summary") {
      const summary = getTablesSummary();
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }

    if (name === "get_table_schema") {
      const { table_name } = GetTableSchemaInputSchema.parse(args);
      const tableDef = getTableDefinition(table_name);
      if (!tableDef) {
        return {
          content: [
            {
              type: "text",
              text: `Table "${table_name}" not found in catalog. Use search_tables or get_tables_summary to discover available tables.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(tableDef, null, 2) }],
      };
    }

    if (name === "search_tables") {
      const { pattern } = SearchTablesInputSchema.parse(args);
      const tables = searchTables(pattern);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                pattern,
                match_count: tables.length,
                tables: tables.map((t) => ({
                  name: t.name,
                  type: t.type,
                  column_count: t.columns.length,
                })),
                full_definitions: tables,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_table_relationships") {
      const { table_name } = GetTableRelationshipsInputSchema.parse(args);
      const relationships = getTableRelationships(table_name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                table: table_name,
                outgoing_count: relationships.outgoing.length,
                incoming_count: relationships.incoming.length,
                ...relationships,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_schema_context") {
      const { table_names } = GetSchemaContextInputSchema.parse(args);
      const context = getSchemaContext(table_names);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                requested_tables: table_names,
                found_tables: Object.keys(context.tables),
                table_count: Object.keys(context.tables).length,
                relationship_count: context.foreign_keys.length,
                ...context,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "find_tables_by_column") {
      const { column_name } = FindTablesByColumnInputSchema.parse(args);
      const results = findTablesByColumn(column_name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                column_name,
                match_count: results.length,
                tables: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_relationship_chain") {
      const { start_table, max_depth } =
        GetRelationshipChainInputSchema.parse(args);
      const chain = getRelationshipChain(start_table, max_depth);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                start_table,
                max_depth,
                related_table_count: chain.length,
                related_tables: chain,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_sales_funnel") {
      const { start_date, end_date } = GetSalesFunnelInputSchema.parse(args);
      
      // Query patterns from database/schema/*_query_template.yml
      // Optimised: replaced RANK() OVER + subquery with MIN() + GROUP BY HAVING
      const sql = `
        SELECT * FROM
        (
          -- Leads
          SELECT 'Leads' as metric, SUM(leads)::int as count
          FROM
          (
            SELECT COUNT(DISTINCT development_opportunities.slug) AS leads
            FROM development_opportunities
            WHERE enquired_at >= ($1::date - INTERVAL '330 minutes')
              AND enquired_at < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
              AND slug NOT IN ('569657C6', '5EB1A14A', '075E54DF')
              AND source != 'DnB'
              AND status != 'trash'

            UNION ALL

            SELECT COUNT(id) AS leads
            FROM enquiries
            WHERE enquiries.vertical = 'development'
              AND enquiry_type = 'enquiry'
              AND leadable_id IS NULL
              AND is_trash != TRUE
              AND enquiries.created_at >= ($1::date - INTERVAL '5 hours 30 minutes')
              AND enquiries.created_at < ($2::date + INTERVAL '1 day' - INTERVAL '5 hours 30 minutes')
          ) leads_data

          UNION ALL

          -- Prospects: first time each opportunity entered 'prospect' stage
          SELECT 'Prospects' as metric, COUNT(*)::int as count
          FROM (
            SELECT development_opportunities.slug
            FROM development_opportunities
            INNER JOIN stage_histories
              ON development_opportunities.id = stage_histories.leadable_id
              AND stage_histories.leadable_type = 'Development::Opportunity'
            INNER JOIN stages
              ON stage_histories.stage_id = stages.id
            WHERE stages.vertical = 'development'
              AND stages.code = 'prospect'
              AND development_opportunities.slug NOT IN ('569657C6', '5EB1A14A', '075E54DF')
            GROUP BY development_opportunities.slug
            HAVING DATE(MIN(stage_histories.updated_at) + INTERVAL '330 minutes') BETWEEN $1 AND $2
          ) prospect_data

          UNION ALL

          -- Accounts: first time each opportunity entered 'account' stage
          SELECT 'Accounts' as metric, COUNT(*)::int as count
          FROM (
            SELECT development_opportunities.slug
            FROM development_opportunities
            INNER JOIN stage_histories
              ON development_opportunities.id = stage_histories.leadable_id
              AND stage_histories.leadable_type = 'Development::Opportunity'
            INNER JOIN stages
              ON stage_histories.stage_id = stages.id
            WHERE stages.vertical = 'development'
              AND stages.code = 'account'
              AND development_opportunities.slug NOT IN ('569657C6', '5EB1A14A', '075E54DF')
            GROUP BY development_opportunities.slug
            HAVING DATE(MIN(stage_histories.updated_at) + INTERVAL '330 minutes') BETWEEN $1 AND $2
          ) account_data

          UNION ALL

          -- Sales: first 'maal_laao' rating per opportunity
          SELECT 'Sales' as metric, COUNT(*)::int as count
          FROM (
            SELECT development_opportunities.slug
            FROM tasks
            INNER JOIN activities ON tasks.id = activities.feedable_id
            INNER JOIN development_opportunities ON development_opportunities.id = activities.leadable_id
            WHERE activities.feedable_type = 'Task'
              AND activities.leadable_type = 'Development::Opportunity'
              AND tasks.rating = 'maal_laao'
              AND development_opportunities.slug NOT IN (
                'd-0010K00001mCaxRQAS',
                'd-0012800001IqdMOAAZ',
                'd-0012800001Y94DuAAJ',
                'd-0012800001Y947rAAB',
                'd-00Q2800000cjE3iEAE'
              )
            GROUP BY development_opportunities.slug
            HAVING DATE(MIN(tasks.performed_at) + INTERVAL '5 hours 30 minutes') BETWEEN $1 AND $2
          ) sales_data
        ) query
        ORDER BY CASE
          WHEN metric = 'Leads' THEN 1
          WHEN metric = 'Prospects' THEN 2
          WHEN metric = 'Accounts' THEN 3
          WHEN metric = 'Sales' THEN 4
          ELSE 5
        END
      `;
      
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
