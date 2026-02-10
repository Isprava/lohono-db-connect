# MCP Server Update: Database Catalog Integration

## Summary

The MCP server has been updated to use the database catalog from the `database/` folder as the primary source of schema intelligence, replacing the previous sales funnel rules dependency.

## What Changed

### Added

1. **New Module: `src/database-catalog.ts`**
   - Loads and provides access to database schema catalogs
   - Reads from `database/schema/database-catalog.json` and `database/schema/foreign-keys-catalog.json`
   - Provides helper functions for querying schema information

2. **New MCP Tools (8 total)**:
   - `get_catalog_metadata` - Get catalog file metadata
   - `get_tables_summary` - List all tables with column counts
   - `get_table_schema` - Get complete schema for a table
   - `search_tables` - Search tables by name pattern
   - `get_table_relationships` - Get foreign key relationships
   - `get_schema_context` - Get schema context for multiple tables
   - `find_tables_by_column` - Find tables with a specific column
   - `get_relationship_chain` - Get related tables through FK relationships

3. **Environment Variable**:
   - `DATABASE_DIR` - Path to database directory (default: `/app/database`)

### Removed

1. **Sales Funnel Rules Tools** (5 tools removed):
   - `get_sales_funnel_context`
   - `classify_sales_intent`
   - `get_query_template`
   - `list_query_patterns`
   - `get_monthly_funnel`

2. **Dependencies**:
   - Removed imports from `schema-rules.ts` in `tools.ts`
   - Removed unused Zod schemas for sales funnel tools

### Modified

1. **`src/tools.ts`**
   - Removed sales funnel tool definitions and handlers
   - Added database catalog tool definitions and handlers
   - Cleaned up unused imports and schemas

2. **`docker-compose.yml`**
   - Added `DATABASE_DIR` environment variable

3. **`src/schema-rules.ts`**
   - Added `hasRules()` function to check if rules are available
   - Added error handling for missing rules file

## File Structure

```
lohono-mcp-server/
├── src/
│   ├── database-catalog.ts  # NEW - Database catalog loader
│   ├── tools.ts              # MODIFIED - Added new tools, removed old ones
│   ├── schema-rules.ts       # MODIFIED - Better error handling
│   └── ...
└── ...

database/
├── schema/
│   ├── database-catalog.json       # Used by MCP server
│   ├── foreign-keys-catalog.json   # Used by MCP server
│   └── ...
└── ...
```

## Environment Variables

```env
# Required for database catalog
DATABASE_DIR=/app/database  # Default path in Docker

# No longer required
SALES_FUNNEL_RULES_PATH  # Can be removed (optional)
```

## Benefits

1. **Simpler Architecture** - No dependency on external YAML rules files
2. **Faster Access** - Pre-built catalog cached in memory
3. **Better Discovery** - Rich search and exploration tools
4. **Relationship Intelligence** - Foreign keys with business context
5. **Version Controlled** - Catalog files tracked in Git

## Usage Examples

### Get Schema Information
```javascript
// Get all tables
const summary = await get_tables_summary();

// Search for tables
const tables = await search_tables({ pattern: "opportunity" });

// Get table schema
const schema = await get_table_schema({ table_name: "development_opportunities" });
```

### Explore Relationships
```javascript
// Get foreign keys for a table
const relationships = await get_table_relationships({ 
  table_name: "development_opportunities" 
});

// Find all related tables
const chain = await get_relationship_chain({ 
  start_table: "development_opportunities",
  max_depth: 2
});
```

### Build SQL Queries
```javascript
// Get schema context for multiple tables
const context = await get_schema_context({ 
  table_names: ["development_opportunities", "agents", "stages"]
});

// Use context.tables and context.foreign_keys to build SQL
```

## Migration Guide

If you were using the old sales funnel rules tools:

1. **`get_sales_funnel_context`** → Use `get_schema_context` for table structure
2. **`classify_sales_intent`** → Implement intent classification in your application
3. **`get_query_template`** → Build queries using `get_schema_context` and `get_table_relationships`
4. **`list_query_patterns`** → Document query patterns separately
5. **`get_monthly_funnel`** → Implement as SQL queries using schema context

## Updating the Catalog

When database schema changes, regenerate the catalog:

```bash
# Inside container
npx tsx /app/database/scripts/catalog-tables-direct.ts

# From host
docker compose exec mcp-server npx tsx /app/database/scripts/catalog-tables-direct.ts
```

## Documentation

- [Database Catalog Integration](./DATABASE_CATALOG_INTEGRATION.md) - Complete guide to new tools
- [Database README](../database/README.md) - Database catalog documentation
- [Schema Catalog README](../database/schema/README.md) - Schema usage examples

## Backward Compatibility

The following tools remain unchanged:
- `query` - Execute SQL queries
- `list_tables` - List tables (via information_schema)
- `describe_table` - Describe table (via information_schema)
- `list_schemas` - List schemas
- `analyze_query` - Analyze SQL queries
- `generate_rules` - Generate rules from SQL
- `fetch_redash_query` - Fetch Redash queries
- `generate_rules_from_redash` - Generate rules from Redash

## Testing

To verify the changes work:

```bash
# Build the server
npm run build

# Start services
docker compose up -d

# Test a tool
curl -X POST http://localhost:3000/tools/get_catalog_metadata
```

---

**Updated:** 2026-02-09  
**Status:** Complete
