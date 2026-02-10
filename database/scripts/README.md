# Database Catalog Scripts

Scripts for generating and maintaining the database schema catalog.

## Scripts

### catalog-tables-direct.ts ⭐ (Recommended)

Direct PostgreSQL connection script that bypasses MCP authentication.

**Features:**
- ✅ Direct database connection
- ✅ No authentication required
- ✅ Uses credentials from `.env` file
- ✅ Fast and reliable
- ✅ Outputs to `database/schema/`

**Usage:**
```bash
npx tsx database/scripts/catalog-tables-direct.ts
```

**Requirements:**
- PostgreSQL database running (port 5433)
- Valid credentials in `.env` file
- `dotenv` package installed

---

### catalog-tables.ts

MCP server-based catalog script using SSE transport.

**Features:**
- Uses MCP server SSE endpoint
- Requires user authentication (email + ACL)
- Good for testing MCP tools
- Outputs to `database/schema/`

**Usage:**
```bash
npx tsx database/scripts/catalog-tables.ts
```

**Requirements:**
- MCP server running (port 3000)
- User email with appropriate ACL permissions
- Valid authentication

---

## Output

Both scripts generate the following files in `database/schema/`:

1. **database-catalog.txt** - Human-readable catalog
2. **database-catalog.json** - Machine-readable JSON

## Environment Variables

Required environment variables (from `.env`):

```bash
DB_HOST=localhost
DB_PORT=5433
DB_USER=lohono_api
DB_PASSWORD=your_password
DB_NAME=lohono_api_production

# For MCP script only
MCP_SERVER_URL=http://localhost:3000/sse
```

## Quick Reference

```bash
# Check database is running
docker compose ps postgres

# Run catalog generation (recommended)
npx tsx database/scripts/catalog-tables-direct.ts

# View generated catalog
cat database/schema/database-catalog.txt
less database/schema/database-catalog.txt

# Query with jq
jq -r '.[] | .name' database/schema/database-catalog.json
```

## Adding to Makefile

Add these commands to your `Makefile`:

```makefile
catalog-db:
	npx tsx database/scripts/catalog-tables-direct.ts

catalog-view:
	@less database/schema/database-catalog.txt

catalog-list:
	@jq -r '.[] | .name' database/schema/database-catalog.json
```

Then use:
```bash
make catalog-db       # Generate catalog
make catalog-view     # View in less
make catalog-list     # List all tables
```

## Troubleshooting

### Connection Errors

```bash
# Verify database is running
docker compose ps postgres

# Test connection
psql -h localhost -p 5433 -U lohono_api -d lohono_api_production
```

### Authentication Errors (MCP script)

The MCP script requires a user email with appropriate ACL permissions. Make sure:
- User exists in `staffs` table
- User has `DASHBOARD_TASK_VIEW` or similar ACL
- User account is active

### Environment Variable Issues

```bash
# Check environment variables are loaded
source .env
echo $DB_PASSWORD

# Or install dotenv (already done)
npm install dotenv
```

## Development

To modify the scripts:

1. Edit the TypeScript files in this directory
2. Test with `npx tsx database/scripts/<script-name>.ts`
3. The scripts will automatically update the catalog in `database/schema/`

## Related Files

- **`database/schema/`** - Output directory for catalog files
- **`.env`** - Environment configuration
- **`README.md`** - Main project documentation
