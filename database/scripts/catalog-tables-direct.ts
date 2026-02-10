#!/usr/bin/env tsx
/**
 * Direct Database Catalog Script
 * 
 * Connects directly to PostgreSQL database and catalogs all tables
 * in a canonical format with their schemas, columns, types, and relationships.
 * Bypasses MCP server authentication.
 */

import { config } from "dotenv";
import pg from "pg";

// Load environment variables from .env file
config();

const { Pool } = pg;

interface TableInfo {
  table_schema: string;
  table_name: string;
  table_type: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: string;
  column_default: string | null;
  constraint_type: string | null;
}

interface TableCatalog {
  schema: string;
  name: string;
  type: string;
  columns: ColumnInfo[];
}

// Create database pool
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
});

async function listSchemas(): Promise<string[]> {
  console.log("📋 Fetching all schemas...");
  
  const result = await pool.query(
    `SELECT schema_name
     FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     ORDER BY schema_name`
  );
  
  console.log(`   Found ${result.rows.length} schemas\n`);
  return result.rows.map((r: { schema_name: string }) => r.schema_name);
}

async function listTablesInSchema(schema: string): Promise<TableInfo[]> {
  console.log(`📊 Fetching tables in schema '${schema}'...`);
  
  const result = await pool.query(
    `SELECT table_schema, table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = $1
     ORDER BY table_name`,
    [schema]
  );
  
  console.log(`   Found ${result.rows.length} tables`);
  return result.rows as TableInfo[];
}

async function describeTable(schema: string, tableName: string): Promise<ColumnInfo[]> {
  const result = await pool.query(
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
    [schema, tableName]
  );
  
  return result.rows as ColumnInfo[];
}

async function catalogAllTables(): Promise<TableCatalog[]> {
  const catalog: TableCatalog[] = [];
  
  // Get all schemas
  const schemas = await listSchemas();
  
  // For each schema, get all tables
  for (const schema of schemas) {
    const tables = await listTablesInSchema(schema);
    
    // For each table, get column information
    for (const table of tables) {
      console.log(`   📝 Describing ${schema}.${table.table_name}...`);
      const columns = await describeTable(schema, table.table_name);
      
      catalog.push({
        schema,
        name: table.table_name,
        type: table.table_type,
        columns,
      });
    }
  }
  
  return catalog;
}

function formatCatalog(catalog: TableCatalog[]): string {
  const lines: string[] = [];
  
  lines.push("╔════════════════════════════════════════════════════════════════════════════╗");
  lines.push("║                         DATABASE TABLE CATALOG                             ║");
  lines.push("╚════════════════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Database: ${process.env.DB_NAME || "lohono_api_production"}`);
  lines.push(`Total Tables: ${catalog.length}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  
  // Group by schema
  const bySchema = catalog.reduce((acc, table) => {
    if (!acc[table.schema]) {
      acc[table.schema] = [];
    }
    acc[table.schema].push(table);
    return acc;
  }, {} as Record<string, TableCatalog[]>);
  
  // Format each schema
  for (const [schema, tables] of Object.entries(bySchema)) {
    lines.push("─".repeat(80));
    lines.push(`SCHEMA: ${schema.toUpperCase()}`);
    lines.push(`Tables: ${tables.length}`);
    lines.push("─".repeat(80));
    lines.push("");
    
    // Sort tables by name
    tables.sort((a, b) => a.name.localeCompare(b.name));
    
    for (const table of tables) {
      lines.push(`📋 ${schema}.${table.name} (${table.type})`);
      
      if (table.columns.length === 0) {
        lines.push("   (No columns found)");
      } else {
        // Group columns by constraint type
        const primaryKeys = table.columns.filter(c => c.constraint_type === "PRIMARY KEY");
        const foreignKeys = table.columns.filter(c => c.constraint_type === "FOREIGN KEY");
        const uniqueKeys = table.columns.filter(c => c.constraint_type === "UNIQUE");
        const regularColumns = table.columns.filter(c => !c.constraint_type);
        
        // Display primary keys first
        if (primaryKeys.length > 0) {
          lines.push("   🔑 Primary Keys:");
          for (const col of primaryKeys) {
            lines.push(`      • ${col.column_name} (${col.data_type})`);
          }
        }
        
        // Display foreign keys
        if (foreignKeys.length > 0) {
          lines.push("   🔗 Foreign Keys:");
          for (const col of foreignKeys) {
            lines.push(`      • ${col.column_name} (${col.data_type})`);
          }
        }
        
        // Display unique keys
        if (uniqueKeys.length > 0) {
          lines.push("   ⭐ Unique Keys:");
          for (const col of uniqueKeys) {
            lines.push(`      • ${col.column_name} (${col.data_type})`);
          }
        }
        
        // Display regular columns
        if (regularColumns.length > 0) {
          lines.push("   📝 Columns:");
          for (const col of regularColumns) {
            const nullable = col.is_nullable === "YES" ? "NULL" : "NOT NULL";
            const maxLen = col.character_maximum_length ? `(${col.character_maximum_length})` : "";
            const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : "";
            lines.push(`      • ${col.column_name}: ${col.data_type}${maxLen} ${nullable}${defaultVal}`);
          }
        }
      }
      
      lines.push("");
    }
  }
  
  return lines.join("\n");
}

async function main() {
  try {
    console.log("🔌 Connecting to PostgreSQL database...");
    console.log(`   Host: ${process.env.DB_HOST || "localhost"}`);
    console.log(`   Port: ${process.env.DB_PORT || "5433"}`);
    console.log(`   Database: ${process.env.DB_NAME || "lohono_api_production"}`);
    console.log(`   User: ${process.env.DB_USER || "lohono_api"}\n`);
    
    // Test connection
    await pool.query("SELECT 1");
    console.log("✅ Connected to database\n");
    
    console.log("🔍 Cataloging all tables...\n");
    const catalog = await catalogAllTables();
    
    console.log("\n" + "═".repeat(80));
    console.log("CATALOG COMPLETE");
    console.log("═".repeat(80) + "\n");
    
    const formatted = formatCatalog(catalog);
    console.log(formatted);
    
    // Save to file
    const fs = await import("fs/promises");
    const outputFile = "database/schema/database-catalog.txt";
    await fs.writeFile(outputFile, formatted);
    console.log(`\n💾 Catalog saved to: ${outputFile}`);
    
    // Also save as JSON for programmatic access
    const jsonFile = "database/schema/database-catalog.json";
    await fs.writeFile(jsonFile, JSON.stringify(catalog, null, 2));
    console.log(`💾 JSON catalog saved to: ${jsonFile}`);
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    await pool.end();
    process.exit(1);
  }
}

main();
