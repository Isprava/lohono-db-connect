# Redash Rule Generation Guide

This guide explains how to use the Redash integration to automatically generate query patterns and business rules from existing Redash queries.

## Overview

The system provides two MCP tools for working with Redash queries:
1. **`fetch_redash_query`** - Fetch SQL from Redash by query ID
2. **`generate_rules_from_redash`** - Fetch SQL and auto-generate rules in one step

## Prerequisites

### Environment Variables
Set these in your `.env` file:

```bash
REDASH_URL=https://redash.isprava.com
REDASH_API_KEY=your_redash_api_key_here
```

### Finding Query IDs
In Redash, query IDs are in the URL:
- `https://redash.isprava.com/queries/42` → Query ID is `42`

## Method 1: Using `generate_rules_from_redash` (Recommended)

This is the fastest method - it fetches and analyzes queries in one step.

### Usage

**Via Chat Client (AIDA):**
Simply ask AIDA:

```
Generate rules from Redash query 42
```

Or for multiple queries:
```
Generate rules from Redash queries 42, 99, 103
```

**Via MCP Tool Call:**

```json
{
  "name": "generate_rules_from_redash",
  "arguments": {
    "query_ids": "42",
    "category": "custom",
    "intent_keywords": ["revenue analysis", "sales breakdown"]
  }
}
```

### Parameters

- **`query_ids`** (required): Single ID or comma-separated list
  - Examples: `"42"`, `"42,99,103"`, `"42, 99, 103"`
- **`category`** (optional): Category for the rule (default: `"custom"`)
  - Examples: `"mtd_aggregate"`, `"aging_reports"`, `"revenue_analysis"`
- **`intent_keywords`** (optional): Natural language keywords that trigger this pattern
  - Example: `["monthly revenue", "sales breakdown", "funnel metrics"]`

### Output

The tool generates three artifacts for each query:

#### 1. YAML Rules Fragment
Contains the business logic to add to `config/sales_funnel_context.yaml`:

```yaml
query_patterns:
  prospect_aging:
    category: aging_reports
    description: Show prospects by age buckets
    user_intent_keywords:
      - prospect aging
      - how old are prospects
    structure: cte_with_aggregation
    applies_date_filter: mtd_current_month
    applies_timezone: true
    applies_slug_exclusions: true
```

#### 2. MCP Tool Definition
JSON Schema to add to `lohono-mcp-server/src/tools.ts`:

```typescript
{
  name: "get_prospect_aging",
  description: "Show prospects by age buckets",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}
```

#### 3. Handler Code
TypeScript code to add to the tool handler:

```typescript
if (name === "get_prospect_aging") {
  const sql = `SELECT ... FROM ...`;
  const result = await executeReadOnlyQuery(sql);
  return {
    content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }]
  };
}
```

## Method 2: Manual Process (More Control)

For more control over the process, use the manual workflow:

### Step 1: Fetch Query from Redash

```json
{
  "name": "fetch_redash_query",
  "arguments": {
    "query_ids": "42"
  }
}
```

This returns the SQL, name, description, tags, and metadata.

### Step 2: Analyze the Query

```json
{
  "name": "analyze_query",
  "arguments": {
    "sql": "SELECT ... FROM ..."
  }
}
```

This extracts structural patterns:
- Tables and joins
- Date filters and timezone conversions
- Aggregations and CASE statements
- CTEs and window functions
- Exclusions and progressive filters

### Step 3: Generate Rules

```json
{
  "name": "generate_rules",
  "arguments": {
    "sql": "SELECT ... FROM ...",
    "pattern_name": "monthly_revenue_breakdown",
    "description": "Monthly revenue by property and source",
    "category": "revenue_analysis",
    "intent_keywords": ["monthly revenue", "revenue breakdown", "sales by property"]
  }
}
```

### Required Parameters for `generate_rules`

- **`sql`**: The SQL query
- **`pattern_name`**: Machine-readable name in `snake_case` (e.g., `"prospect_aging"`)
- **`description`**: Human-readable description
- **`category`**: Category for organization (e.g., `"mtd_aggregate"`, `"aging_reports"`)

### Optional Parameters

- **`intent_keywords`**: Array of natural language phrases that should trigger this pattern

## Defining Prompt Descriptions

The **prompt description** is the natural language description that helps users understand what the query does and when to use it.

### In `generate_rules_from_redash`

The tool automatically uses the Redash query's **name** and **description** fields:

- **Pattern Name**: Derived from the Redash query name (converted to snake_case)
- **Description**: Uses the Redash query description (or name if no description exists)
- **Intent Keywords**: You can provide these via the `intent_keywords` parameter

Example:
```json
{
  "name": "generate_rules_from_redash",
  "arguments": {
    "query_ids": "42",
    "category": "revenue_analysis",
    "intent_keywords": [
      "show me monthly revenue",
      "revenue by property",
      "sales breakdown by month"
    ]
  }
}
```

### In Manual `generate_rules`

You have full control:

```json
{
  "name": "generate_rules",
  "arguments": {
    "sql": "SELECT ...",
    "pattern_name": "property_revenue_monthly",
    "description": "Monthly revenue breakdown by property with year-over-year comparison",
    "category": "revenue_analysis",
    "intent_keywords": [
      "monthly property revenue",
      "revenue by property and month",
      "property sales trends"
    ]
  }
}
```

### Best Practices for Descriptions

1. **Be Specific**: Clearly state what data is returned
   - ❌ "Get revenue data"
   - ✅ "Monthly revenue breakdown by property with YoY comparison"

2. **Include Key Dimensions**: Mention groupings and filters
   - ✅ "Prospect aging by source and region for current month"

3. **Highlight Special Logic**: Note important calculations
   - ✅ "MTD funnel metrics excluding test properties and DnB leads"

4. **Use Action Verbs**: Start with verbs like "Show", "Get", "Calculate", "Analyze"
   - ✅ "Show prospects grouped by age buckets (0-7, 8-14, 15-30, 31+ days)"

5. **Match User Language**: Use terms users naturally say
   - Intent: "How many leads are aging?" → Description: "Lead aging analysis by time bucket"

## Integration Process

After generating rules, integrate them into your codebase:

### 1. Add YAML Rules

Add the generated YAML to `config/sales_funnel_context.yaml` under the appropriate section:

```yaml
sales_funnel:
  query_patterns:
    # ... existing patterns ...
    
    # New pattern
    property_revenue_monthly:
      category: revenue_analysis
      description: "Monthly revenue breakdown by property"
      user_intent_keywords:
        - monthly property revenue
        - revenue by property
      # ... rest of rules ...
```

### 2. Add Tool Definition

Add to `lohono-mcp-server/src/tools.ts` in the `toolDefinitions` array:

```typescript
export const toolDefinitions = [
  // ... existing tools ...
  
  {
    name: "get_property_revenue_monthly",
    description: "Monthly revenue breakdown by property with YoY comparison",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: []
    }
  }
];
```

### 3. Add Handler Code

Add to the `handleToolCall` function in `tools.ts`:

```typescript
if (name === "get_property_revenue_monthly") {
  const sql = `
    SELECT 
      property_name,
      DATE_TRUNC('month', booking_date) as month,
      SUM(revenue) as total_revenue
    FROM bookings
    GROUP BY property_name, month
    ORDER BY month DESC, property_name
  `;
  const result = await executeReadOnlyQuery(sql);
  return {
    content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }]
  };
}
```

### 4. Rebuild and Deploy

```bash
npm run build
docker compose up -d --build mcp-server mcp-client
```

## Example Workflow

### Complete Example: Generating Rules for a Revenue Query

1. **Identify Redash Query**: Query ID 156 contains monthly revenue analysis

2. **Generate Rules**:
```
Generate rules from Redash query 156 with category "revenue_analysis" and keywords "monthly revenue", "revenue breakdown", "sales by month"
```

3. **Review Output**: The tool returns YAML, tool definition, and handler code

4. **Customize** (if needed):
   - Adjust description for clarity
   - Add/modify intent keywords
   - Update SQL if business logic changed

5. **Integrate**: Copy artifacts to respective files

6. **Test**: Ask AIDA:
```
Show me the monthly revenue breakdown
```

## Troubleshooting

### "Redash API key is required"
- Set `REDASH_API_KEY` in your `.env` file
- Ensure the API key has read permissions

### "HTTP 404: Not Found"
- Check the query ID is correct
- Ensure the query exists in Redash
- Verify you have access to the query

### "Invalid query ID"
- Query IDs must be numeric
- Use comma or space separation for multiple IDs: `"42,99,103"` or `"42 99 103"`

### Generated Rules Need Adjustment
- Use the manual process for more control
- Customize the generated YAML before adding to config
- Adjust SQL in the handler if business logic needs updates

## Tips

1. **Batch Processing**: Generate rules for multiple related queries at once
   ```
   Generate rules from Redash queries 42, 43, 44, 45
   ```

2. **Category Organization**: Use consistent categories
   - `mtd_aggregate` - Month-to-date aggregations
   - `aging_reports` - Time-bucket analyses
   - `revenue_analysis` - Revenue and sales metrics
   - `funnel_metrics` - Sales funnel stages
   - `custom` - One-off or specialized queries

3. **Intent Keywords**: Include variations users might say
   ```json
   "intent_keywords": [
     "monthly revenue",
     "revenue by month",
     "monthly sales",
     "what's the monthly revenue",
     "show monthly sales"
   ]
   ```

4. **Iterate**: Generate, test, refine based on user feedback

## Next Steps

After generating rules:
1. Test the query pattern via AIDA chat
2. Monitor which intent keywords users actually use
3. Update rules based on usage patterns
4. Document special business logic in the YAML comments
