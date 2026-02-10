# Database Directory

Complete database catalog and maintenance scripts for the Lohono production database.

## 📁 Directory Structure

```
database/
├── schema/              # Database schema catalog
│   ├── README.md                   # Schema catalog documentation
│   ├── CATALOG-README.md           # Quick reference guide
│   ├── CATALOG-SUMMARY.md          # Comprehensive summary
│   ├── database-catalog.txt        # Human-readable catalog (166 KB)
│   └── database-catalog.json       # Machine-readable catalog (763 KB)
│
└── scripts/             # Catalog generation scripts
    ├── README.md                   # Scripts documentation
    ├── catalog-tables-direct.ts    # Direct PostgreSQL connection (recommended)
    └── catalog-tables.ts           # MCP server connection
```

## 📊 Database Overview

- **Database:** lohono_api_production
- **Host:** localhost:5433
- **Total Tables:** 298 (295 base tables + 3 views)
- **Schema:** public
- **Last Cataloged:** 2026-02-09T13:53:33.042Z

## 🚀 Quick Start

### View the Catalog

```bash
# Read documentation
cat database/schema/README.md

# View full catalog
less database/schema/database-catalog.txt

# Search for specific table
grep -A 30 "development_opportunities" database/schema/database-catalog.txt
```

### Query with jq

```bash
# List all tables
jq -r '.[] | .name' database/schema/database-catalog.json

# Find tables by pattern
jq '.[] | select(.name | contains("opportunity"))' database/schema/database-catalog.json

# Get table details
jq '.[] | select(.name == "development_opportunities")' database/schema/database-catalog.json
```

### Regenerate Catalog

```bash
# Using direct PostgreSQL connection (recommended)
npx tsx database/scripts/catalog-tables-direct.ts

# Using MCP server (requires authentication)
npx tsx database/scripts/catalog-tables.ts
```

## 📖 Documentation

### Schema Catalog (`schema/`)

Contains the complete database schema catalog with:
- All table definitions
- Column specifications with types and constraints
- Primary keys, foreign keys, and indexes
- Categorized table summaries
- Usage examples and query patterns

**Key Files:**
- **README.md** - Main documentation with usage examples
- **CATALOG-README.md** - Quick reference guide
- **CATALOG-SUMMARY.md** - Comprehensive summary organized by categories
- **database-catalog.txt** - Human-readable full catalog
- **database-catalog.json** - JSON format for programmatic access

### Scripts (`scripts/`)

Tools for generating and maintaining the database catalog.

**Key Scripts:**
- **catalog-tables-direct.ts** ⭐ - Direct PostgreSQL connection (recommended)
- **catalog-tables.ts** - MCP server-based connection

See [scripts/README.md](./scripts/README.md) for detailed documentation.

## 🎯 Major Table Categories

### Core Business Tables
- **Sales Funnel:** development_opportunities, enquiries, stage_histories, tasks
- **Contacts:** contacts, agents, staffs
- **Chapter (Development):** chapter_opportunities, chapter_properties, chapter_areas
- **Properties:** properties, reservations, billing_details

### Supporting Systems
- **Asset Management:** asset_area_assets, asset_audit_tasks, asset_audit_records
- **Financial:** invoices, payments, credit_histories, transactions
- **Operations:** guests, operations_emails, notifications
- **Inventory:** inventory_items, purchase_orders, vendors

## 🔍 Common Use Cases

### Find Tables Related to Sales

```bash
jq '.[] | select(.name | contains("development") or contains("enquir") or contains("stage")) | {name, columns: (.columns | length)}' database/schema/database-catalog.json
```

### Get All Column Details for a Table

```bash
jq '.[] | select(.name == "development_opportunities") | .columns[] | {name: .column_name, type: .data_type, nullable: .is_nullable}' database/schema/database-catalog.json
```

### Find Tables with Soft Deletes

```bash
jq '.[] | select(.columns[] | .column_name == "deleted_at") | .name' database/schema/database-catalog.json
```

### Count Columns in All Tables

```bash
jq -r '.[] | "\(.name): \(.columns | length) columns"' database/schema/database-catalog.json | sort -t: -k2 -n
```

## 🔗 Database Connection

```bash
# Direct PostgreSQL connection
psql -h localhost -p 5433 -U lohono_api -d lohono_api_production

# Using Docker
docker compose exec postgres psql -U lohono_api -d lohono_api_production

# Via project Makefile
make db-shell
```

## 🛠️ Maintenance

### Regular Updates

Regenerate the catalog when:
- Database schema changes (migrations)
- New tables are added
- Column definitions are modified
- Indexes or constraints change

```bash
# Regenerate catalog
npx tsx database/scripts/catalog-tables-direct.ts

# Verify changes
git diff database/schema/
```

### Version Control

The catalog files are tracked in Git to provide schema history:
- Review diffs to understand schema changes
- Track evolution of database structure
- Document changes in commit messages

## 📝 Notes

- All tables are in the `public` schema
- Primary keys are typically `id` columns of type `bigint`
- Timestamps use `timestamp without time zone` (UTC)
- Most tables have `created_at` and `updated_at` audit columns
- Soft deletes via `deleted_at` columns
- JSONB columns for flexible data storage
- ACL-based access control via `staffs.acl_array`

## 🔒 Access Control

Database access is controlled through:
- PostgreSQL user permissions
- ACL enforcement in MCP server
- Staff authentication in application

See [config/acl.yml](../config/acl.yml) for ACL configuration.

## 📚 Related Documentation

- [Main README](../README.md) - Project documentation
- [MCP Documentation](../DOCUMENTATION.md) - MCP server details
- [ACL Configuration](../config/acl.yml) - Access control rules
- [Schema Rules](../config/schema-rules.yml) - Business rules

---

**Database:** lohono_api_production  
**Location:** `/home/isprava/AILABS/MCP/lohono-db-context/database/`  
**Last Updated:** 2026-02-09T13:53:33.042Z
