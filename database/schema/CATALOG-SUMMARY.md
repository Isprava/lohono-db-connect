# Lohono Database Catalog Summary

## Overview

**Database:** `lohono_api_production`  
**Host:** localhost:5433  
**Generated:** 2026-02-09T13:53:33.042Z  
**Total Tables:** 298

## Schema Statistics

- **Schema:** public
- **Base Tables:** 295
- **Views:** 3

## Catalog Files

1. **`database-catalog.txt`** (166 KB) - Human-readable text format with organized layout
2. **`database-catalog.json`** (763 KB) - Machine-readable JSON format for programmatic access

## Major Table Categories

### Access Control & Authentication
- `acl_masters` - Access control list definitions
- `staffs` - Staff user accounts with ACL permissions
- `active_admin_comments` - Admin interface comments

### Sales & Opportunities
- `development_opportunities` - Development sales opportunities
- `agents` - Sales agents and channel partners
- `enquiries` - Customer inquiries
- `contacts` - Contact information
- `stage_histories` - Sales stage progression tracking

### Chapter (Real Estate Development)
- `chapter_opportunities` - Development project opportunities
- `chapter_properties` - Development properties
- `chapter_areas` - Property areas and layouts
- `chapter_designs` - Design specifications
- `chapter_delivery_timelines` - Project delivery schedules
- `chapter_payment_schedule_versions` - Payment plans
- `chapter_change_requests` - Change request management
- `chapter_finance_quotations` - Financial quotes
- `chapter_vendor_quotations` - Vendor quotes
- `chapter_bank_accounts` - Banking details
- `chapter_receipts` - Payment receipts

### Property Management
- `properties` - Property listings
- `property_areas` - Property area definitions
- `property_availabilities` - Booking availability
- `property_channels` - Distribution channels
- `reservations` - Booking reservations
- `billing_details` - Billing information
- `credits` - Credit transactions

### Asset Management
- `asset_area_assets` - Asset inventory by area
- `asset_audit_tasks` - Asset audit assignments
- `asset_audit_records` - Audit findings
- `asset_audit_issues` - Asset issues tracking
- `asset_parent_sku_items` - Parent SKU definitions
- `asset_child_sku_items` - Child SKU variants

### Tasks & Activities
- `tasks` - Task management
- `activities` - Activity feed/timeline
- `appointments` - Scheduled appointments
- `checklists` - Task checklists
- `automations` - Workflow automations
- `automation_entities` - Automation entity mappings
- `automation_attributes` - Automation attributes

### Financial Management
- `invoices` - Invoice records
- `payments` - Payment transactions
- `credit_histories` - Credit history tracking
- `taxes` - Tax records
- `currencies` - Currency definitions
- `transactions` - Financial transactions

### Operations & Guest Management
- `guests` - Guest information
- `guest_experiences` - Guest experience tracking
- `operations_emails` - Operational emails
- `mailers` - Email templates
- `notifications` - System notifications
- `on_premise_contacts` - On-site contact information

### Surveys & Feedback
- `surveys` - Survey definitions
- `survey_answers` - Survey responses
- `app_feedbacks` - App feedback collection
- `reviews` - Customer reviews

### Inventory & Procurement
- `inventory_items` - Inventory catalog
- `vendors` - Vendor information
- `purchase_orders` - Purchase order management
- `goods_received_notes` - Goods receipt tracking
- `stock_transfers` - Stock transfer records

### Location & Geography
- `countries` - Country definitions
- `regions` - Regional divisions
- `cities` - City information
- `locations` - Location/venue details

### System & Configuration
- `ar_internal_metadata` - Active Record metadata
- `schema_migrations` - Database migration history
- `constant_mappings` - System constants
- `counters` - Sequence counters
- `categories` - Category taxonomies
- `brands` - Brand definitions

### Reports & Analytics
- `redash_queries` - Saved Redash queries
- `dashboard_widgets` - Dashboard configurations
- `stages` - Stage definitions (sales funnel)
- `stage_histories` - Stage transition history

## Key Relationships

### Sales Funnel Flow
```
enquiries → development_opportunities → stage_histories → tasks
          ↓                          ↓
       contacts                  activities
```

### Property Booking Flow
```
properties → property_availabilities → reservations → billing_details
                                                    ↓
                                                 payments
```

### Asset Management Flow
```
asset_parent_sku_items → asset_child_sku_items → asset_area_assets
                                                          ↓
                                                   asset_audit_tasks
                                                          ↓
                                                   asset_audit_records
```

### Chapter Development Flow
```
chapter_opportunities → chapter_properties → chapter_areas
                     ↓                      ↓
              chapter_designs          chapter_delivery_timelines
                     ↓                      ↓
         chapter_finance_quotations  chapter_payment_schedule_versions
```

## Access Control

The database implements role-based access control through:
- `staffs.acl_array` - Array of ACL permission strings per staff member
- `acl_masters` - Master list of available ACL permissions

Common ACL permissions include:
- `STAFF_EDIT` - Superuser access
- `DASHBOARD_TASK_VIEW` - Dashboard viewing
- `DASHBOARD_TASK_REPORT_DOWNLOAD` - Report access
- `DEVELOPMENT_OPP_VIEW` - Opportunity viewing
- `ENQUIRY_LIST_VIEW` - Enquiry listing

## Views

Three database views exist for reporting/analytics:
1. View 1 (details in full catalog)
2. View 2 (details in full catalog)
3. View 3 (details in full catalog)

## Usage

### View the Full Catalog

```bash
# Text format (human-readable)
cat database-catalog.txt

# JSON format (programmatic access)
jq . database-catalog.json
```

### Query Specific Tables

```bash
# Find tables by name pattern
jq '.[] | select(.name | contains("opportunity"))' database-catalog.json

# Get all tables with their column count
jq -r '.[] | "\(.schema).\(.name): \(.columns | length) columns"' database-catalog.json

# Find tables with specific column
jq '.[] | select(.columns[] | .column_name == "slug")' database-catalog.json
```

### Connect to Database

```bash
# Using psql
psql -h localhost -p 5433 -U lohono_api -d lohono_api_production

# Using MCP server (requires authentication)
# See catalog-tables.ts for MCP client example

# Direct connection (bypasses MCP)
# See catalog-tables-direct.ts for direct PostgreSQL access
```

## Scripts

Two catalog generation scripts are available:

1. **`catalog-tables-direct.ts`** (Recommended)
   - Connects directly to PostgreSQL
   - No authentication required
   - Uses credentials from `.env` file
   - Run: `npx tsx catalog-tables-direct.ts`

2. **`catalog-tables.ts`**
   - Connects via MCP server
   - Requires user authentication (email + ACL permissions)
   - Uses SSE transport
   - Run: `npx tsx catalog-tables.ts`

## Regenerating the Catalog

```bash
# Ensure database is running
docker compose ps postgres

# Load environment variables and run
npx tsx catalog-tables-direct.ts

# Output files
# - database-catalog.txt (human-readable)
# - database-catalog.json (machine-readable)
```

## Notes

- All tables are in the `public` schema
- Primary keys are typically `id` columns of type `bigint`
- Timestamps use `timestamp without time zone` type
- Most tables include `created_at` and `updated_at` audit columns
- Many tables use `slug` columns for human-readable identifiers
- JSONB columns are used for flexible/dynamic data (e.g., `address_details`, `details`)
- Soft deletes are implemented via `deleted_at` columns in many tables

## Related Documentation

- **README.md** - Full project documentation
- **DOCUMENTATION.md** - Detailed MCP server documentation
- **config/acl.yml** - Access control configuration
- **config/schema-rules.yml** - Business rules for sales funnel queries
