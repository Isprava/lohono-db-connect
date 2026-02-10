# NLQ → QueryPlan Orchestration - Updated Implementation

## Overview

The NLQ (Natural Language Query) resolver has been updated to ensure:

1. **✅ Metric Schema Reuse** - All queries reference existing Matrix schemas (no custom SQL)
2. **✅ Time Range Resolution** - Always delegates to existing TimeRangeResolver
3. **✅ Isprava Attribution** - Automatic disclaimer when "Isprava" not mentioned in query
4. **✅ Funnel Composition** - Funnel queries compose from 4 existing stage schemas

## Architecture

```
NLQ Text → Token ize → Detect Intent → Resolve Metrics → Resolve Time → Generate Plan
                                            ↓                   ↓              ↓
                                      Matrix Schema        TimeRange      output_meta
                                       References          Resolver     (disclaimer)
```

## Key Changes

### 1. Output Metadata with Isprava Disclaimer

**Type Update:**
```typescript
interface QueryPlan {
  // ... existing fields
  
  output_meta: {
    disclaimer: string | null;
    scope?: string;
  };
}
```

**Logic:**
- If query does **NOT** contain "Isprava" (case-insensitive) → Add disclaimer
- If query **DOES** contain "Isprava" → No disclaimer, mark as explicit

**Function:**
```typescript
export function requiresIspravaDisclaimer(query: string): boolean {
  return !/isprava/i.test(query);
}

export function generateOutputMeta(query: string) {
  if (requiresIspravaDisclaimer(query)) {
    return {
      disclaimer: "Note: Results shown are for Isprava data only."
    };
  } else {
    return {
      disclaimer: null,
      scope: "Isprava (explicit in query)"
    };
  }
}
```

### 2. Metric ID Mapping

**Valid Metric IDs (from Matrix Schema):**
- `FUNNEL.LEADS_ENTERED` - Single metric: Lead count
- `FUNNEL.PROSPECTS_ENTERED` - Single metric: Prospect count
- `FUNNEL.ACCOUNTS_ENTERED` - Single metric: Account count
- `FUNNEL.SALES_ENTERED` - Single metric: Sales count
- `FUNNEL.CONVERSION` - Derived metric: Conversion rate between stages
- `FUNNEL.DROPOFF` - Derived metric: Drop-off analysis
- `FUNNEL.VELOCITY` - Derived metric: Time between stages
- `FUNNEL.AGING` - Derived metric: Stuck/aging records
- `FUNNEL.TREND` - Derived metric: Time series

**Intent → Metric Mapping:**

| Intent | Metric IDs | Notes |
|--------|-----------|-------|
| `STAGE_METRIC` | One of: LEADS_ENTERED, PROSPECTS_ENTERED, ACCOUNTS_ENTERED, SALES_ENTERED | Based on detected stage |
| `FUNNEL_SNAPSHOT` | ALL 4: LEADS_ENTERED, PROSPECTS_ENTERED, ACCOUNTS_ENTERED, SALES_ENTERED | Composes full funnel |
| `CONVERSION` | FUNNEL.CONVERSION | Plus conversion spec (from_stage, to_stage) |
| `DROPOFF` | FUNNEL.DROPOFF | Leakage analysis |
| `VELOCITY` | FUNNEL.VELOCITY | Plus velocity spec (from_stage, to_stage, aggregation) |
| `AGING` | FUNNEL.AGING | Plus aging spec (stage, threshold_days, operator) |
| `TREND` | FUNNEL.TREND | Plus trend_granularity |
| `BREAKDOWN` | Based on detected stages | Plus group_by dimensions |
| `RANKING` | Based on detected stages | Plus ranking spec (limit, direction) |
| `COMPARISON` | Based on detected stages | Plus comparison spec (base_range, compare_range) |

### 3. Time Range Resolution

**Always delegates to TimeRangeResolver:**
```typescript
// Extract time expression from tokens
const time_expression = tokens.time_expressions[0] || 'MTD';

// Delegate to existing resolver
const time_range = resolveTimeRange(time_expression, config);
```

**Never implements date math in NLQ layer** - all date calculations happen in TimeRangeResolver.

### 4. Funnel Snapshot Composition

**Funnel queries MUST compose from 4 existing schemas:**
```typescript
if (intent === 'FUNNEL_SNAPSHOT') {
  return [
    'FUNNEL.LEADS_ENTERED',
    'FUNNEL.PROSPECTS_ENTERED',
    'FUNNEL.ACCOUNTS_ENTERED',
    'FUNNEL.SALES_ENTERED'
  ];
}
```

**Never generates custom SQL for funnel** - always references existing metric builders.

## Query Examples

### Single Stage Metrics

```typescript
// Input: "leads mtd"
{
  intent: 'STAGE_METRIC',
  metric_ids: ['FUNNEL.LEADS_ENTERED'],
  stages: ['LEAD'],
  time_range: { /* from TimeRangeResolver */ },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}

// Input: "Isprava sales last week"
{
  intent: 'STAGE_METRIC',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  time_range: { /* from TimeRangeResolver */ },
  output_meta: {
    disclaimer: null,
    scope: "Isprava (explicit in query)"
  }
}
```

### Funnel Snapshot

```typescript
// Input: "show funnel mtd"
{
  intent: 'FUNNEL_SNAPSHOT',
  metric_ids: [
    'FUNNEL.LEADS_ENTERED',
    'FUNNEL.PROSPECTS_ENTERED',
    'FUNNEL.ACCOUNTS_ENTERED',
    'FUNNEL.SALES_ENTERED'
  ],
  stages: ['LEAD', 'PROSPECT', 'ACCOUNT', 'SALE'],
  time_range: { /* from TimeRangeResolver */ },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Conversion

```typescript
// Input: "lead to sale conversion ytd"
{
  intent: 'CONVERSION',
  metric_ids: ['FUNNEL.CONVERSION'],
  stages: ['LEAD', 'SALE'],
  time_range: { /* from TimeRangeResolver */ },
  conversion: {
    from_stage: 'LEAD',
    to_stage: 'SALE'
  },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Velocity

```typescript
// Input: "avg days lead to sale mtd"
{
  intent: 'VELOCITY',
  metric_ids: ['FUNNEL.VELOCITY'],
  stages: ['LEAD', 'SALE'],
  time_range: { /* from TimeRangeResolver */ },
  velocity: {
    from_stage: 'LEAD',
    to_stage: 'SALE',
    aggregation: 'avg'
  },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Aging

```typescript
// Input: "prospects older than 14 days"
{
  intent: 'AGING',
  metric_ids: ['FUNNEL.AGING'],
  stages: ['PROSPECT'],
  time_range: { /* from TimeRangeResolver */ },
  aging: {
    stage: 'PROSPECT',
    threshold_days: 14,
    operator: '>'
  },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Trend

```typescript
// Input: "daily leads last 14 days"
{
  intent: 'TREND',
  metric_ids: ['FUNNEL.TREND'],
  stages: ['LEAD'],
  time_range: { /* from TimeRangeResolver */ },
  trend_granularity: 'day',
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Breakdown

```typescript
// Input: "sales by source mtd"
{
  intent: 'BREAKDOWN',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  time_range: { /* from TimeRangeResolver */ },
  group_by: ['source'],
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Ranking

```typescript
// Input: "top 10 sources by sales mtd"
{
  intent: 'RANKING',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  time_range: { /* from TimeRangeResolver */ },
  group_by: ['source'],
  ranking: {
    order_by: 'FUNNEL.SALES_ENTERED',
    direction: 'desc',
    limit: 10
  },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

### Comparison

```typescript
// Input: "sales mtd vs last month"
{
  intent: 'COMPARISON',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  time_range: { /* from TimeRangeResolver */ },
  comparison: {
    type: 'vs_last_month',
    base_range: { /* current MTD */ },
    compare_range: { /* last month */ }
  },
  output_meta: {
    disclaimer: "Note: Results shown are for Isprava data only."
  }
}
```

## Test Coverage

**51 comprehensive test cases** covering:

- ✅ 10 Single stage metrics
- ✅ 5 Funnel snapshots
- ✅ 5 Trend queries
- ✅ 5 Breakdown queries
- ✅ 4 Conversion queries
- ✅ 3 Drop-off queries
- ✅ 4 Velocity queries
- ✅ 4 Aging queries
- ✅ 3 Comparison queries
- ✅ 4 Ranking queries
- ✅ 4 Disclaimer logic tests

**All tests validate:**
1. Only existing metric_schema_id(s) used
2. time_range produced by TimeRangeResolver
3. Disclaimer present when NLQ lacks "Isprava"
4. Funnel requests compose the 4 stage metric schemas

## Validation Rules

### ✅ Absolute Rules (MUST)

1. **Only route to existing Matrix schemas** - No custom SQL in NLQ layer
2. **Always use TimeRangeResolver** - No date math in NLQ parser
3. **Always apply Isprava disclaimer rule** - Check for "Isprava" in query
4. **Funnel = 4 stage composition** - Never a single ad hoc metric

### ❌ Prohibited Actions (MUST NOT)

1. ❌ Do not write raw SQL in NLQ layer
2. ❌ Do not redefine metric logic
3. ❌ Do not redefine time logic
4. ❌ Do not create ad hoc funnel metrics

## Error Handling

If an intent cannot be satisfied by existing schemas:
```typescript
{
  error: {
    code: "UNSUPPORTED_INTENT_WITH_EXISTING_SCHEMAS",
    message: "This NLQ request requires a metric schema that is not defined yet.",
    suggested_action: "Define new metric schema in Matrix registry"
  }
}
```

## Usage

```typescript
import { resolveNLQ } from './nlq-resolver';

// Basic usage
const plan = resolveNLQ('leads mtd');

// With custom config
const plan = resolveNLQ('sales last week', {
  timezone: 'Asia/Kolkata',
  fiscal_config: { fiscal_year_start_month: 4 },
  week_start: 'monday',
  now: '2026-02-09T12:00:00+05:30'
});

// Check disclaimer
if (plan.output_meta.disclaimer) {
  console.log(plan.output_meta.disclaimer);
  // "Note: Results shown are for Isprava data only."
}

// Use metric IDs to fetch from Matrix registry
const metrics = plan.metric_ids.map(id => MetrixRegistry.get(id));

// Use time_range for SQL generation
const sql = buildSQL({
  metrics,
  time_range: plan.time_range,
  filters: plan.filters
});
```

## Next Steps

1. **Matrix Schema Registry** - Implement metric builders for each ID
2. **SQL Generation Layer** - Convert QueryPlan + Matrix schemas → SQL
3. **Result Formatting** - Apply output_meta disclaimer to responses
4. **UI Integration** - Display disclaimer when present

## References

- `src/nlq-resolver/types.ts` - Type definitions
- `src/nlq-resolver/parser.ts` - Parser implementation
- `src/nlq-resolver/__tests__/comprehensive.test.ts` - 51 test cases
- `src/time-range/` - Time range resolution
