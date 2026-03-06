import { z } from "zod";
import {
  getTableDefinition,
  getTableRelationships,
  searchTables,
  getTablesSummary,
} from "../database-catalog.js";
import type { ToolPlugin, ToolResult } from "./types.js";

// ── 1. get_table_schema ─────────────────────────────────────────────────────

const GetTableSchemaInputSchema = z.object({
  table_name: z.string().min(1, "table_name is required"),
});

const getTableSchemaPlugin: ToolPlugin = {
  definition: {
    name: "get_table_schema",
    description:
      `Get column definitions and foreign key relationships for a database table. ` +
      `Returns column names, data types, nullability, defaults, constraints, and related tables. ` +
      `Use this to verify column names before writing SQL.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        table_name: {
          type: "string",
          description: "Exact table name (e.g. 'rental_properties', 'rental_reservations').",
        },
      },
      required: ["table_name"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const { table_name } = GetTableSchemaInputSchema.parse(args);
    const table = getTableDefinition(table_name);
    if (!table) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Table '${table_name}' not found. Use search_tables to find the correct name.`,
          }),
        }],
        isError: true,
      };
    }
    const relationships = getTableRelationships(table_name);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ table, relationships }, null, 2),
      }],
    };
  },
};

// ── 2. search_tables ────────────────────────────────────────────────────────

const SearchTablesInputSchema = z.object({
  pattern: z.string().min(1, "search pattern is required"),
});

const searchTablesPlugin: ToolPlugin = {
  definition: {
    name: "search_tables",
    description:
      `Search for database tables by name (case-insensitive substring match). ` +
      `Returns matching table names with column counts. Use this to discover table names before querying.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Substring to search in table names (e.g. 'rental', 'reservation', 'cancel').",
        },
      },
      required: ["pattern"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const { pattern } = SearchTablesInputSchema.parse(args);
    const tables = searchTables(pattern);
    const summary = tables.map((t) => ({
      name: t.name,
      type: t.type,
      column_count: t.columns.length,
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ match_count: summary.length, tables: summary }, null, 2),
      }],
    };
  },
};

// ── 3. get_tables_summary ───────────────────────────────────────────────────

const getTablesSummaryPlugin: ToolPlugin = {
  definition: {
    name: "get_tables_summary",
    description:
      `List all tables in the database with their column counts. ` +
      `Use this to get an overview of the database structure.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  async handler(): Promise<ToolResult> {
    const summary = getTablesSummary();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ table_count: summary.length, tables: summary }, null, 2),
      }],
    };
  },
};

// ── Export ───────────────────────────────────────────────────────────────────

export const schemaCatalogPlugins: ToolPlugin[] = [
  getTableSchemaPlugin,
  searchTablesPlugin,
  getTablesSummaryPlugin,
];
