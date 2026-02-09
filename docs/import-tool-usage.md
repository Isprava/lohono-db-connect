# Redash Import Tool - Quick Reference

## Overview

The Redash import tool automatically fetches queries from Redash, generates business rules, and updates your configuration files. After importing, you can restart services to make the new queries available.

## Quick Start

### Method 1: Using the Shell Script (Easiest)

```bash
# Import a single query
./scripts/import-and-restart.sh 42

# Import multiple queries
./scripts/import-and-restart.sh 42,99,103

# Import with custom category
./scripts/import-and-restart.sh 42 --category revenue_analysis

# Import with keywords
./scripts/import-and-restart.sh 42 --keywords "monthly revenue,sales breakdown"

# Dry run (see what would happen without making changes)
./scripts/import-and-restart.sh 42 --dry-run
```

The script will:
1. Fetch queries from Redash
2. Generate and update configuration
3. Ask if you want to restart services
4. Rebuild and restart if you confirm

### Method 2: Using npm Script

```bash
# Import only (no restart prompt)
npm run import-redash -- 42

# Import and auto-restart
npm run import-redash -- 42 --restart

# Import with category
npm run import-redash -- 42 --category revenue_analysis

# Import multiple with keywords
npm run import-redash -- 42,99,103 --keywords "monthly revenue,sales breakdown"

# Dry run
npm run import-redash -- 42 --dry-run
```

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--category <cat>` | Set category for the query pattern | `--category revenue_analysis` |
| `--keywords <k1,k2>` | Comma-separated intent keywords | `--keywords "monthly revenue,sales"` |
| `--dry-run` | Preview changes without applying | `--dry-run` |
| `--no-backup` | Don't create backup files | `--no-backup` |
| `--restart` | Automatically restart services after import | `--restart` |

## What Gets Updated

### 1. YAML Configuration
**File:** `config/sales_funnel_rules_v2.yml`

The tool adds a new entry to `query_patterns`:
```yaml
query_patterns:
  your_new_pattern:
    category: custom
    description: "Your query description"
    user_intent_keywords:
      - "keyword 1"
      - "keyword 2"
    structure: cte_with_aggregation
    # ... other generated rules
```

**Backup:** Automatically created as `config/sales_funnel_rules_v2.yml.backup.<timestamp>`

### 2. Tool Definitions (Manual Step Required)

The tool outputs code snippets for you to manually add to `lohono-mcp-server/src/tools.ts`:

#### Tool Definition
Add to the `toolDefinitions` array:
```typescript
{
  name: "get_your_pattern",
  description: "Your query description",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```

#### Handler Code
Add to the `handleToolCall` function:
```typescript
if (name === "get_your_pattern") {
  const sql = `SELECT ... FROM ...`;
  const result = await executeReadOnlyQuery(sql);
  return {
    content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }]
  };
}
```

## Complete Workflow Example

```bash
# 1. Import query 156 with category and keywords
./scripts/import-and-restart.sh 156 --category revenue_analysis --keywords "monthly revenue,revenue breakdown"

# 2. The tool shows you:
#    - Import summary
#    - Updated YAML config
#    - Tool definition code to add
#    - Handler code to add

# 3. Manually add the tool definition and handler to tools.ts

# 4. If you didn't auto-restart, build and restart:
npm run build
docker compose up -d --build mcp-server mcp-client

# 5. Test in AIDA chat:
"Show me the monthly revenue breakdown"
```

## Categories

Use consistent categories to organize your queries:

- `mtd_aggregate` - Month-to-date aggregations
- `aging_reports` - Time-bucket analyses  
- `revenue_analysis` - Revenue and sales metrics
- `funnel_metrics` - Sales funnel stages
- `custom` - One-off or specialized queries (default)

## Intent Keywords

Keywords help Claude understand when to use your query pattern. Include variations users might say:

```bash
--keywords "monthly revenue,revenue by month,monthly sales,what's the monthly revenue"
```

## Dry Run

Always test with `--dry-run` first to see what would change:

```bash
./scripts/import-and-restart.sh 42,99,103 --dry-run
```

This shows:
- Which queries would be imported
- What would be added to the YAML config
- Tool definitions that would need to be added
- No files are modified

## Troubleshooting

### "Redash API key is required"
Set in `.env`:
```bash
REDASH_API_KEY=your_api_key_here
REDASH_URL=https://redash.isprava.com
```

### "Query ID not found"
- Verify the query ID exists in Redash
- Check you have access to the query
- Ensure the query ID is numeric

### "Pattern already exists"
The tool will overwrite existing patterns. Use `--dry-run` to check before proceeding.

### Services not restarting
Manual restart:
```bash
npm run build
docker compose up -d --build mcp-server mcp-client
```

Check logs if issues persist:
```bash
docker compose logs -f mcp-server mcp-client
```

## Tips

1. **Batch Import**: Import related queries together
   ```bash
   ./scripts/import-and-restart.sh 42,43,44,45 --category revenue_analysis
   ```

2. **Descriptive Keywords**: Use phrases users naturally say
   ```bash
   --keywords "show monthly revenue,revenue breakdown,sales by month"
   ```

3. **Test First**: Always use `--dry-run` for large imports
   ```bash
   ./scripts/import-and-restart.sh 42,43,44,45 --dry-run
   ```

4. **Review Before Restart**: Check the generated code before restarting services

5. **Backup Safety**: Backups are automatic unless you use `--no-backup`

## Manual Restart (Without Import)

If you manually edited configurations:

```bash
# Build TypeScript
npm run build

# Restart only the affected services
docker compose up -d --build mcp-server mcp-client

# Or restart all services
docker compose restart
```

## Files Modified

- ✅ Automatically updated: `config/sales_funnel_rules_v2.yml`
- ⚠️ Manual update required: `lohono-mcp-server/src/tools.ts`

## Next Steps After Import

1. ✅ YAML config updated automatically
2. ⚠️ Add tool definition and handler to `tools.ts`
3. ✅ Build: `npm run build`
4. ✅ Restart: `docker compose up -d --build mcp-server mcp-client`
5. ✅ Test in AIDA chat interface
6. ✅ Monitor usage and refine keywords
