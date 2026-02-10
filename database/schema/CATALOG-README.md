# Database Catalog - Quick Reference

## 📊 Catalog Overview

Successfully cataloged the **lohono_api_production** database with complete schema information.

### Generated Files

| File | Size | Description |
|------|------|-------------|
| `database-catalog.txt` | 166 KB | Human-readable catalog with organized formatting |
| `database-catalog.json` | 763 KB | Machine-readable JSON for programmatic access |
| `CATALOG-SUMMARY.md` | 8.0 KB | Comprehensive summary with categories and usage guide |
| `foreign-keys-catalog.json` | 19 KB | Foreign key relationships and schema intelligence |
| `lead_query_template.yml` | 25 KB | Parameterized lead query template with FK relationships |
| `prospect_query_template.yml` | 26 KB | Parameterized prospect query template with FK relationships |
| `account_query_template.yml` | 34 KB | Parameterized account query template with FK relationships |
| `sale_query_template.yml` | 39 KB | Parameterized sale query template with FK relationships |

### Statistics

- **Total Tables:** 298
- **Base Tables:** 295
- **Views:** 3
- **Schema:** public
- **Database:** lohono_api_production

## 🚀 Quick Start

### View the Catalog

```bash
# Human-readable format
cat database-catalog.txt | less

# First 50 tables
head -200 database-catalog.txt

# Search for specific tables
grep -A 20 "development_opportunities" database-catalog.txt
```

### Query with jq

```bash
# List all tables
jq -r '.[] | .name' database-catalog.json

# Find tables by pattern
jq '.[] | select(.name | contains("opportunity"))' database-catalog.json

# Get table with column details
jq '.[] | select(.name == "development_opportunities")' database-catalog.json

# Count columns per table
jq -r '.[] | "\(.name): \(.columns | length) columns"' database-catalog.json

# Find tables with specific column
jq '.[] | select(.columns[] | .column_name == "slug") | .name' database-catalog.json
```

## 📋 Key Tables Reference

### Sales Funnel Core Tables

**development_opportunities** (36 columns)
- Primary Key: `id`
- Key columns: `slug`, `current_stage`, `status`, `interested_location`, `enquired_at`
- Purpose: Main sales opportunities tracking

**enquiries** (28 columns)
- Primary Key: `id`
- Key columns: `name`, `mobile`, `email`, `interested_in`, `leadable_id`
- Purpose: Customer inquiry records

**stage_histories** (8 columns)
- Primary Key: `id`
- Key columns: `leadable_id`, `action`, `stage_id`, `updated_at`
- Purpose: Track sales stage progression

**tasks** (14 columns)
- Primary Key: `id`
- Key columns: `performed_at`, `medium_id`, `rating`, `minutes`
- Purpose: Sales tasks and activities

**staffs** (28 columns)
- Primary Key: `id`
- Key columns: `name`, `handle`, `mobile`, `email`, `acl_array`
- Purpose: Staff users with ACL permissions

### Chapter (Development) Tables

- `chapter_opportunities` - Development projects
- `chapter_properties` - Properties under development
- `chapter_areas` - Property areas and layouts
- `chapter_delivery_timelines` - Project schedules
- `chapter_payment_schedule_versions` - Payment plans
- `chapter_finance_quotations` - Financial quotes
- `chapter_change_requests` - Change requests

### Property Management Tables

- `properties` - Property listings
- `reservations` - Bookings
- `billing_details` - Billing information
- `property_availabilities` - Availability calendar

### Asset Management Tables

- `asset_area_assets` - Asset inventory
- `asset_audit_tasks` - Audit assignments
- `asset_audit_records` - Audit findings
- `asset_parent_sku_items` - SKU definitions

## 🔍 Common Queries

### Find Sales Funnel Tables

```bash
jq '.[] | select(.name | contains("development") or contains("enquir") or contains("stage") or contains("task")) | {name, columns: (.columns | length)}' database-catalog.json
```

### Find Tables with Timestamps

```bash
jq '.[] | select(.columns[] | .column_name == "created_at") | .name' database-catalog.json
```

### Find Tables with Soft Deletes

```bash
jq '.[] | select(.columns[] | .column_name == "deleted_at") | .name' database-catalog.json
```

### Get Column Types for a Table

```bash
jq '.[] | select(.name == "development_opportunities") | .columns[] | {name: .column_name, type: .data_type, nullable: .is_nullable}' database-catalog.json
```

### Query Foreign Key Relationships

```bash
# List all foreign keys
jq '.foreign_keys[] | {table, column, references: .references_table}' foreign-keys-catalog.json

# Find FKs for a specific table
jq '.foreign_keys[] | select(.table == "development_opportunities")' foreign-keys-catalog.json

# Get polymorphic relationships
jq '.polymorphic_relationships[]' foreign-keys-catalog.json

# View common join patterns
jq '.common_join_patterns' foreign-keys-catalog.json
```

## 🛠️ Regenerate Catalog

```bash
# Make sure database is running
docker compose ps postgres

# Run the catalog script
npx tsx catalog-tables-direct.ts

# Or via make command (if added to Makefile)
make catalog-db
```

## 📦 Scripts

### catalog-tables-direct.ts (Recommended)
- ✅ Direct PostgreSQL connection
- ✅ No MCP authentication required
- ✅ Uses `.env` credentials
- Fast and reliable

### catalog-tables.ts
- Uses MCP server SSE transport
- Requires user authentication
- Useful for testing MCP tools

## 🔗 Connect to Database

```bash
# PostgreSQL CLI
psql -h localhost -p 5433 -U lohono_api -d lohono_api_production

# Using Docker
docker compose exec postgres psql -U lohono_api -d lohono_api_production

# Via Makefile
make db-shell
```

## 📖 Documentation

### Core Catalog Files
- **CATALOG-SUMMARY.md** - Detailed catalog summary with categories
- **database-catalog.txt** - Full catalog in text format
- **database-catalog.json** - Full catalog in JSON format
- **README.md** - Main project documentation
- **DOCUMENTATION.md** - MCP server documentation

### Schema Intelligence Files
- **foreign-keys-catalog.json** - Foreign key relationships, polymorphic associations, and join patterns
- **lead_query_template.yml** - Parameterized lead query with FK relationships and common patterns
- **prospect_query_template.yml** - Parameterized prospect query with stage history tracking and window functions
- **account_query_template.yml** - Parameterized account query with complete funnel progression tracking
- **sale_query_template.yml** - Parameterized sale query with task rating system and Maal Laao logic

## 🎯 Next Steps

1. Review **CATALOG-SUMMARY.md** for comprehensive overview
2. Explore **database-catalog.txt** for full table details
3. Use **database-catalog.json** for programmatic access
4. Query specific tables using jq examples above
5. Connect to database to run SQL queries

## 📝 Notes

- All timestamps are in UTC (without timezone)
- Most tables use `bigint` primary keys
- Soft deletes via `deleted_at` columns
- JSONB columns for flexible data storage
- ACL-based access control via `staffs.acl_array`

---

**Generated:** 2026-02-09T13:53:33.042Z  
**Database:** lohono_api_production  
**Host:** localhost:5433
