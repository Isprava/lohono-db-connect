#!/usr/bin/env tsx
/**
 * Catalog All Tables Script
 * 
 * Connects to the MCP server and catalogs all tables in the database
 * in a canonical format with their schemas, columns, types, and relationships.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

interface TableInfo {
  schema: string;
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

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:3000/sse";

async function connectToMCP(): Promise<Client> {
  console.log(`🔌 Connecting to MCP server at ${MCP_SERVER_URL}...`);
  
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
  const client = new Client(
    {
      name: "table-catalog-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  await client.connect(transport);
  console.log("✅ Connected to MCP server\n");
  
  return client;
}

async function listSchemas(client: Client): Promise<string[]> {
  console.log("📋 Fetching all schemas...");
  
  const result = await client.callTool({
    name: "list_schemas",
    arguments: {},
  });

  if (!result.content || result.content.length === 0) {
    throw new Error("No schemas found");
  }

  const schemas = JSON.parse(result.content[0].text);
  console.log(`   Found ${schemas.length} schemas\n`);
  
  return schemas.map((s: { schema_name: string }) => s.schema_name);
}

async function listTablesInSchema(client: Client, schema: string): Promise<TableInfo[]> {
  console.log(`📊 Fetching tables in schema '${schema}'...`);
  
  const result = await client.callTool({
    name: "list_tables",
    arguments: { schema },
  });

  if (!result.content || result.content.length === 0) {
    return [];
  }

  const tables = JSON.parse(result.content[0].text) as TableInfo[];
  console.log(`   Found ${tables.length} tables`);
  
  return tables;
}

async function describeTable(client: Client, schema: string, tableName: string): Promise<ColumnInfo[]> {
  const result = await client.callTool({
    name: "describe_table",
    arguments: { 
      schema,
      table_name: tableName 
    },
  });

  if (!result.content || result.content.length === 0) {
    return [];
  }

  return JSON.parse(result.content[0].text) as ColumnInfo[];
}

async function catalogAllTables(client: Client): Promise<TableCatalog[]> {
  const catalog: TableCatalog[] = [];
  
  // Get all schemas
  const schemas = await listSchemas(client);
  
  // For each schema, get all tables
  for (const schema of schemas) {
    const tables = await listTablesInSchema(client, schema);
    
    // For each table, get column information
    for (const table of tables) {
      console.log(`   📝 Describing ${schema}.${table.table_name}...`);
      const columns = await describeTable(client, schema, table.table_name);
      
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
    const client = await connectToMCP();
    
    console.log("🔍 Cataloging all tables...\n");
    const catalog = await catalogAllTables(client);
    
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
    
    await client.close();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();
