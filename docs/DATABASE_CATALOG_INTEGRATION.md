# Database Catalog Integration

This document describes the database catalog integration in the MCP server, which provides schema intelligence using the database catalog files in the `database/` folder.

## Overview

The MCP server now includes comprehensive database schema intelligence powered by:
- **Database Catalog** (`database/schema/database-catalog.json`) - Complete table definitions with all columns, types, and constraints
- **Foreign Keys Catalog** (`database/schema/foreign-keys-catalog.json`) - All foreign key relationships with business context

## New MCP Tools

### Database Catalog Tools

#### 1. `get_catalog_metadata`
Get metadata about the database catalog files - paths, existence, counts.

**Usage:**
```json
{
  "name": "get_catalog_metadata",
  "arguments": {}
}
```

**Returns:**
```json
{
  "database_catalog": {
    "path": "/app/database/schema/database-catalog.json",
    "exists": true,
    "table_count": 298
  },
  "foreign_keys_catalog": {
    "path": "/app/database/schema/foreign-keys-catalog.json",
    "exists": true,
    "relationship_count": 156,
    "metadata": {
      "database": "lohono_api_production",
      "schema": "public",
      "generated_at": "2026-02-09T14:14:44Z"
    }
  }
}
```

#### 2. `get_tables_summary`
Get a summary of all tables with column counts, sorted by size.

**Usage:**
```json
{
  "name": "get_tables_summary",
  "arguments": {}
}
```

**Returns:**
```json
[
  { "name": "development_opportunities", "type": "BASE TABLE", "column_count": 89 },
  { "name": "properties", "type": "BASE TABLE", "column_count": 67 },
  ...
]
```

#### 3. `get_table_schema`
Get complete schema definition for a specific table from the catalog.

**Usage:**
```json
{
  "name": "get_table_schema",
  "arguments": {
    "table_name": "development_opportunities"
  }
}
```

**Returns:**
```json
{
  "schema": "public",
  "name": "development_opportunities",
  "type": "BASE TABLE",
  "columns": [
    {
      "column_name": "id",
      "data_type": "bigint",
      "is_nullable": "NO",
      "constraint_type": "PRIMARY KEY"
    },
    ...
  ]
}
```

#### 4. `search_tables`
Search for tables by name pattern (case-insensitive substring match).

**Usage:**
```json
{
  "name": "search_tables",
  "arguments": {
    "pattern": "opportunity"
  }
}
```

**Returns:**
```json
{
  "pattern": "opportunity",
  "match_count": 3,
  "tables": [
    { "name": "development_opportunities", "type": "BASE TABLE", "column_count": 89 },
    { "name": "chapter_opportunities", "type": "BASE TABLE", "column_count": 45 }
  ],
  "full_definitions": [ /* complete table schemas */ ]
}
```

#### 5. `get_table_relationships`
Get all foreign key relationships for a specific table (both outgoing and incoming).

**Usage:**
```json
{
  "name": "get_table_relationships",
  "arguments": {
    "table_name": "development_opportunities"
  }
}
```

**Returns:**
```json
{
  "table": "development_opportunities",
  "outgoing_count": 3,
  "incoming_count": 12,
  "outgoing": [
    {
      "table": "development_opportunities",
      "column": "agent_id",
      "references_table": "agents",
      "references_column": "id",
      "relationship_type": "many_to_one",
      "description": "Agent who brought this opportunity",
      "business_context": "Links opportunity to the agent/channel partner",
      "join_example": "LEFT JOIN agents ON agents.id = development_opportunities.agent_id"
    }
  ],
  "incoming": [ /* tables that reference this table */ ]
}
```

#### 6. `get_schema_context`
Get complete schema context for SQL generation - table definitions and foreign key relationships for multiple tables.

**Usage:**
```json
{
  "name": "get_schema_context",
  "arguments": {
    "table_names": ["development_opportunities", "stage_histories", "stages"]
  }
}
```

**Returns:**
```json
{
  "requested_tables": ["development_opportunities", "stage_histories", "stages"],
  "found_tables": ["development_opportunities", "stage_histories", "stages"],
  "table_count": 3,
  "relationship_count": 5,
  "tables": {
    "development_opportunities": { /* full table definition */ },
    "stage_histories": { /* full table definition */ },
    "stages": { /* full table definition */ }
  },
  "foreign_keys": [ /* all relevant foreign key relationships */ ]
}
```

#### 7. `find_tables_by_column`
Find all tables that have a specific column name.

**Usage:**
```json
{
  "name": "find_tables_by_column",
  "arguments": {
    "column_name": "deleted_at"
  }
}
```

**Returns:**
```json
{
  "column_name": "deleted_at",
  "match_count": 87,
  "tables": [
    {
      "table": "development_opportunities",
      "column": {
        "column_name": "deleted_at",
        "data_type": "timestamp without time zone",
        "is_nullable": "YES"
      }
    }
  ]
}
```

#### 8. `get_relationship_chain`
Get all tables connected through foreign key relationships starting from a specific table.

**Usage:**
```json
{
  "name": "get_relationship_chain",
  "arguments": {
    "start_table": "development_opportunities",
    "max_depth": 2
  }
}
```

**Returns:**
```json
{
  "start_table": "development_opportunities",
  "max_depth": 2,
  "related_table_count": 15,
  "related_tables": [
    "development_opportunities",
    "agents",
    "staffs",
    "stages",
    "enquiries",
    "stage_histories",
    "activities",
    ...
  ]
}
```

## Architecture

### Module: `database-catalog.ts`

This module provides functions to load and query the database catalog files:

**Key Functions:**
- `loadDatabaseCatalog()` - Load the complete table catalog
- `loadForeignKeysCatalog()` - Load the foreign key relationships
- `getTableDefinition(name)` - Get a specific table's schema
- `searchTables(pattern)` - Search tables by name
- `getTableRelationships(name)` - Get FK relationships
- `getSchemaContext(names)` - Get context for multiple tables
- `findTablesByColumn(column)` - Find tables with a column
- `getRelationshipChain(table, depth)` - Get related tables

### Environment Variables

- `DATABASE_DIR` - Path to the database directory (default: `/app/database`)
  - Catalog files are expected at `${DATABASE_DIR}/schema/`
  
### File Locations

```
/app/database/
├── schema/
│   ├── database-catalog.json       # Complete table definitions
│   ├── foreign-keys-catalog.json   # FK relationships
│   └── README.md                    # Schema documentation
└── scripts/
    └── catalog-tables-direct.ts    # Catalog regeneration script
```

## Updating the Catalog

When the database schema changes, regenerate the catalog:

```bash
# Inside the container
npx tsx /app/database/scripts/catalog-tables-direct.ts

# Or from the host
docker compose exec mcp-server npx tsx /app/database/scripts/catalog-tables-direct.ts
```

The script will update:
- `database/schema/database-catalog.json`
- `database/schema/database-catalog.txt`

## Integration with Schema Intelligence

The database catalog works alongside the existing sales funnel rules:

- **Database Catalog** → Provides raw schema structure (tables, columns, FKs)
- **Sales Funnel Rules** → Provides business logic and query patterns

Both can be used together for comprehensive SQL generation:
1. Use `get_schema_context` to get table structures
2. Use `get_sales_funnel_context` to get business rules
3. Combine both to generate correct, business-aware SQL

## Error Handling

If catalog files are missing:
```json
{
  "error": "Database catalog not found at /app/database/schema/database-catalog.json. Run: npx tsx database/scripts/catalog-tables-direct.ts"
}
```

If sales funnel rules are missing (optional):
```json
{
  "error": "Sales funnel rules not available. Set SALES_FUNNEL_RULES_PATH environment variable or place sales_funnel_rules_v2.yml at /app/database/config/"
}
```

## Benefits

1. **Faster Schema Queries** - Pre-built catalog avoids repeated database queries
2. **Offline Schema Access** - No need for active database connection to explore schema
3. **Relationship Intelligence** - Explicit foreign key relationships with business context
4. **Search Capabilities** - Easily discover tables and columns
5. **Version Control** - Catalog files can be tracked in Git for schema history

## Examples

### Example 1: Building a Query with Schema Context

```javascript
// 1. Find relevant tables
const tables = await search_tables({ pattern: "opportunity" });

// 2. Get schema context for the tables
const context = await get_schema_context({ 
  table_names: ["development_opportunities", "agents", "stages"] 
});

// 3. Get foreign key relationships
const relationships = await get_table_relationships({ 
  table_name: "development_opportunities" 
});

// 4. Use the context to build SQL with correct joins
```

### Example 2: Discovering Schema

```javascript
// Find all tables with soft deletes
const softDeleteTables = await find_tables_by_column({ 
  column_name: "deleted_at" 
});

// Find all related tables starting from opportunities
const relatedTables = await get_relationship_chain({ 
  start_table: "development_opportunities",
  max_depth: 2
});
```

## See Also

- [Database README](../database/README.md) - Database catalog documentation
- [Schema Catalog README](../database/schema/README.md) - Schema usage examples
- [DOCUMENTATION.md](../DOCUMENTATION.md) - Main MCP documentation
