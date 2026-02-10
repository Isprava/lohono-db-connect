# Database Catalog Documentation

Complete catalog of the Lohono production database (`lohono_api_production`) with all tables, columns, types, and relationships.

## 📁 Files in this Directory

### Documentation
- **[CATALOG-README.md](./CATALOG-README.md)** - Quick reference guide with examples
- **[CATALOG-SUMMARY.md](./CATALOG-SUMMARY.md)** - Comprehensive summary organized by categories

### Catalog Data
- **[database-catalog.txt](./database-catalog.txt)** (166 KB) - Human-readable text format
- **[database-catalog.json](./database-catalog.json)** (763 KB) - Machine-readable JSON format

## 📊 Quick Stats

- **Database:** lohono_api_production
- **Total Tables:** 298 (295 base tables + 3 views)
- **Schema:** public
- **Generated:** 2026-02-09T13:53:33.042Z

## 🚀 Quick Start

### View Catalog Files

```bash
# Read the quick reference
cat database/schema/CATALOG-README.md

# Read the comprehensive summary
cat database/schema/CATALOG-SUMMARY.md

# View full catalog (text format)
less database/schema/database-catalog.txt

# Search for specific table
grep -A 30 "development_opportunities" database/schema/database-catalog.txt
```

### Query with jq

```bash
# List all table names
jq -r '.[] | .name' database/schema/database-catalog.json

# Find tables by pattern
jq '.[] | select(.name | contains("opportunity"))' database/schema/database-catalog.json

# Get specific table details
jq '.[] | select(.name == "development_opportunities")' database/schema/database-catalog.json

# Count columns per table
jq -r '.[] | "\(.name): \(.columns | length) columns"' database/schema/database-catalog.json
```

## 🔄 Regenerate Catalog

Scripts are located in `database/scripts/`:

```bash
# Direct PostgreSQL connection (recommended)
npx tsx database/scripts/catalog-tables-direct.ts

# Via MCP server (requires authentication)
npx tsx database/scripts/catalog-tables.ts
```

Output files will be generated in the project root. Move them here:

```bash
mv database-catalog.* database/schema/
mv CATALOG-*.md database/schema/
```

## 📖 Related Documentation

- [Project README](../../README.md) - Main project documentation
- [MCP Documentation](../../DOCUMENTATION.md) - MCP server details
- [ACL Configuration](../../config/acl.yml) - Access control rules
- [Schema Rules](../../config/schema-rules.yml) - Business rules

## 🎯 Major Table Categories

### Core Business
- **Sales:** `development_opportunities`, `enquiries`, `stage_histories`, `tasks`
- **Contacts:** `contacts`, `agents`, `staffs`
- **Chapter:** `chapter_opportunities`, `chapter_properties`, `chapter_areas`
- **Properties:** `properties`, `reservations`, `billing_details`

### Supporting Systems
- **Assets:** `asset_area_assets`, `asset_audit_tasks`, `asset_audit_records`
- **Financial:** `invoices`, `payments`, `credit_histories`, `transactions`
- **Operations:** `guests`, `operations_emails`, `notifications`
- **Inventory:** `inventory_items`, `purchase_orders`, `vendors`

## 🔍 Key Tables Reference

| Table | Columns | Purpose |
|-------|---------|---------|
| development_opportunities | 36 | Sales opportunity tracking |
| enquiries | 28 | Customer inquiries |
| staffs | 28 | Staff users with ACL |
| stage_histories | 8 | Sales stage progression |
| tasks | 14 | Sales tasks/activities |
| chapter_opportunities | 42 | Development projects |
| properties | 44 | Property listings |
| reservations | 35 | Booking records |

## 💡 Usage Tips

1. **Start with CATALOG-README.md** for quick reference
2. **Read CATALOG-SUMMARY.md** for comprehensive overview
3. **Use database-catalog.json** for programmatic queries
4. **Search database-catalog.txt** for specific tables
5. **Regenerate catalog** when schema changes

---

**Location:** `database/schema/`  
**Last Updated:** 2026-02-09T13:53:33.042Z
