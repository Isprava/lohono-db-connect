# ACL Tool Configuration Migration to MongoDB

## Overview

As of this change, **tool ACL configurations (`tool_acls`) are now managed exclusively via MongoDB**. The `acl.yml` file is now only used for global ACL settings (`default_policy`, `superuser_acls`, `public_tools`, `disabled_tools`).

## What Changed?

### Before
- Tool ACLs were defined in `database/schema/acl.yml` under the `tool_acls` section
- MongoDB could override YAML configs, but YAML was used as a baseline
- Changes required editing YAML file and restarting the server

### After
- Tool ACLs are stored **only** in MongoDB (`acl_configs` collection)
- The `tool_acls` section has been removed from `acl.yml`
- Changes can be made dynamically via Admin UI or API without server restart
- YAML is only used for global settings and as a fallback if MongoDB is unavailable

## Migration Steps

### 1. Backup Your Current ACL Configuration

Before migrating, save your current `acl.yml` file:

```bash
cp database/schema/acl.yml database/schema/acl.yml.backup
```

### 2. Run the Migration Script

The migration script will read the existing `tool_acls` from your YAML file and populate MongoDB:

```bash
# From the project root
npx tsx database/scripts/migrate-tool-acls-to-mongo.ts
```

**Example output:**
```
🔄 Starting tool_acls migration to MongoDB...

✅ Loaded YAML from: /path/to/acl.yml
📋 Found 12 tool(s) with ACL configs:

   - list_tables: [DASHBOARD_TASK_VIEW, DASHBOARD_TASK_REPORT_DOWNLOAD]
   - describe_table: [DASHBOARD_TASK_VIEW, DASHBOARD_TASK_REPORT_DOWNLOAD]
   ...

✅ Connected to MongoDB: mongodb://localhost:27017/mcp_client

💾 Migrating tool_acls to MongoDB...

   ✅ Inserted: list_tables
   ✅ Inserted: describe_table
   ...

✅ Migration complete!
   📊 Summary:
      - Inserted: 12 tool(s)
      - Updated: 0 tool(s)
```

### 3. Verify Migration

Check that tool ACLs are in MongoDB:

```bash
# Using MongoDB CLI
mongosh mcp_client --eval "db.acl_configs.find().pretty()"

# Or via API (requires admin access)
curl http://localhost:4000/api/admin/acl/tools \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 4. Restart Your Servers

Restart the MCP server and client to pick up the new configuration:

```bash
# Restart lohono-mcp-server
cd lohono-mcp-server
npm run build
npm start

# Restart lohono-mcp-client
cd lohono-mcp-client
npm run build
npm start
```

## Managing Tool ACLs

### Via Admin UI

Access the admin interface at `http://localhost:3001/admin` (adjust port as needed) and navigate to the ACL management section.

### Via API

#### List All Tool ACL Configs
```bash
GET /api/admin/acl/tools
```

**Response:**
```json
[
  {
    "toolName": "get_sales_funnel",
    "acls": ["DEVELOPMENT_OPP_LIST_VIEW", "DASHBOARD_ENQUIRIES_VIEW"],
    "updatedAt": "2024-01-15T10:30:00Z",
    "updatedBy": "admin@example.com"
  }
]
```

#### Update ACLs for a Tool
```bash
PUT /api/admin/acl/tools/:toolName
Content-Type: application/json

{
  "acls": ["ACL_NAME_1", "ACL_NAME_2"]
}
```

#### Delete ACL Config for a Tool
```bash
DELETE /api/admin/acl/tools/:toolName
```

#### Get Available ACL Names
```bash
GET /api/admin/acl/available-acls
```

**Response:**
```json
[
  "STAFF_EDIT",
  "DASHBOARD_TASK_VIEW",
  "DEVELOPMENT_OPP_LIST_VIEW",
  ...
]
```

#### Get Available Tool Names
```bash
GET /api/admin/acl/available-tools
```

## MongoDB Collections

### `acl_configs` Collection

Stores per-tool ACL requirements:

```javascript
{
  "_id": ObjectId("..."),
  "toolName": "get_sales_funnel",
  "acls": ["DEVELOPMENT_OPP_LIST_VIEW", "DASHBOARD_ENQUIRIES_VIEW"],
  "updatedAt": ISODate("2024-01-15T10:30:00Z"),
  "updatedBy": "admin@example.com"
}
```

### `acl_global_config` Collection

Stores global ACL settings (also editable via API):

```javascript
{
  "_id": ObjectId("..."),
  "default_policy": "open",
  "superuser_acls": ["STAFF_EDIT"],
  "public_tools": ["get_catalog_metadata", "get_tables_summary"],
  "disabled_tools": ["query"],
  "updatedAt": ISODate("2024-01-15T10:30:00Z"),
  "updatedBy": "admin@example.com"
}
```

## Fallback Behavior

If MongoDB is unavailable:
- Global settings are read from `acl.yml`
- **Tool ACLs will be empty** (tools will use `default_policy`)
- Warning logs will be emitted

## Updated acl.yml Format

The new `acl.yml` file only contains global settings:

```yaml
# Policy when a tool is NOT listed in tool_acls (MongoDB):
#   "open"  → allow any authenticated user
#   "deny"  → block unless explicitly listed
default_policy: "open"

# Tools that are completely disabled (no access for anyone)
disabled_tools:
  - query  # Use specialized tools instead

# ACL values that grant access to ALL tools
superuser_acls:
  - STAFF_EDIT

# Tools that require NO authentication at all
public_tools:
  - get_catalog_metadata
  - get_tables_summary
  - get_table_schema
  # ...

# The tool_acls section has been removed.
# Tool ACLs are now managed via MongoDB only.
```

## Benefits

1. **Dynamic Updates**: Change tool ACLs without restarting the server
2. **Audit Trail**: Track who changed what and when (`updatedBy`, `updatedAt`)
3. **Admin UI**: Manage ACLs via web interface instead of editing files
4. **Centralized**: All dynamic configuration in one place (MongoDB)
5. **Scalable**: Easier to manage in multi-instance deployments

## Troubleshooting

### Tool ACLs Not Working After Migration

1. Check MongoDB connection:
   ```bash
   mongosh $MONGODB_URI --eval "db.adminCommand('ping')"
   ```

2. Verify tool ACLs are in MongoDB:
   ```bash
   mongosh $MONGODB_DB_NAME --eval "db.acl_configs.find().pretty()"
   ```

3. Check server logs for ACL-related warnings

4. Clear ACL cache (30-second TTL) and retry

### Migration Script Fails

- Ensure MongoDB is running and accessible
- Check `MONGODB_URI` and `MONGODB_DB_NAME` environment variables
- Verify the YAML file path is correct

### Tools Not Listed in ListTools Response

- Check if tool has ACL requirements in MongoDB
- Verify user has the required ACLs (`staffs.acl_array`)
- Check `default_policy` setting

## Rollback (if needed)

If you need to rollback to YAML-based config:

1. Restore your backed-up YAML file:
   ```bash
   cp database/schema/acl.yml.backup database/schema/acl.yml
   ```

2. Revert the code changes in `lohono-mcp-server/src/acl/config.ts`

3. Rebuild and restart the server

However, this is **not recommended** as the MongoDB-based approach is more flexible and maintainable.

## Support

For questions or issues, contact the development team or open an issue in the repository.
