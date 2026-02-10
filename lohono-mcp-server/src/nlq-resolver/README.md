# NLQ Intent Resolver

Natural Language Query (NLQ) intent resolver for the Sales Funnel MCP server. Maps natural language queries to QueryPlan objects that reference existing metric schemas and time-range resolvers.

## Architecture

```
NLQ → Intent Resolver → Metric Resolver → TimeRange Resolver → QueryPlan (uses existing builders)
```

### Design Principles

**✅ DOES:**
- Map NLQ to existing schema references
- Orchestrate metric and time-range resolvers
- Detect intent and extract parameters
- Produce QueryPlan objects

**❌ DOES NOT:**
- Write raw SQL
- Redefine metric logic
- Redefine time logic
- Implement data fetching

## QueryPlan Output Contract

```typescript
interface QueryPlan {
  intent: QueryIntent;              // Type of query
  metric_ids: MetricId[];           // References to MetricRegistry
  stages: FunnelStage[];            // Stages involved
  time_range: TimeRange;            // From TimeRangeResolver
  group_by?: DimensionType[];       // Dimensions for breakdown
  filters?: FilterSpec[];           // Additional filters
  comparison?: ComparisonSpec;      // Period comparison
  ranking?: RankingSpec;            // Top N ranking
  trend_granularity?: TrendGranularity;
  conversion?: { from_stage, to_stage };
  velocity?: { from_stage, to_stage, aggregation };
  aging?: { stage, threshold_days, operator };
  original_query: string;
  confidence: number;               // 0-1 score
}
```

## Supported Query Types

### 1️⃣ Single Stage Metrics

Get count for a specific funnel stage.

**Intent:** `STAGE_METRIC`  
**Metric:** `FUNNEL.<STAGE>_ENTERED`

```typescript
// Examples
"Leads MTD"
"Sales last week"
"Accounts in Jan 2026"
"Prospects YTD"
"Enquiries last 90 days"
"Bookings this month"

// QueryPlan
{
  intent: 'STAGE_METRIC',
  metric_ids: ['FUNNEL.LEADS_ENTERED'],
  stages: ['LEAD'],
  time_range: { start: '2026-02-01T00:00:00+05:30', ... }
}
```

### 2️⃣ Funnel Snapshot

View all stages at once.

**Intent:** `FUNNEL_SNAPSHOT`  
**Metrics:** All stage metrics

```typescript
// Examples
"Show funnel MTD"
"Funnel last 30 days"
"Pipeline overview this quarter"

// QueryPlan
{
  intent: 'FUNNEL_SNAPSHOT',
  metric_ids: [
    'FUNNEL.LEADS_ENTERED',
    'FUNNEL.PROSPECTS_ENTERED',
    'FUNNEL.ACCOUNTS_ENTERED',
    'FUNNEL.SALES_ENTERED'
  ],
  stages: ['LEAD', 'PROSPECT', 'ACCOUNT', 'SALE'],
  time_range: { ... }
}
```

### 3️⃣ Trend Queries

Time-series data with granularity.

**Intent:** `TREND`  
**Metric:** `FUNNEL.TREND`

```typescript
// Examples
"Daily leads last 14 days"
"Weekly sales MTD"
"Monthly prospects YTD"
"Quarterly accounts trend"

// QueryPlan
{
  intent: 'TREND',
  metric_ids: ['FUNNEL.TREND'],
  stages: ['LEAD'],
  trend_granularity: 'day',
  time_range: { ... }
}
```

### 4️⃣ Breakdown Queries

Group by dimensions (source, agent, location, etc.).

**Intent:** `BREAKDOWN`  
**Metric:** Stage metric  
**Group By:** Dimension(s)

```typescript
// Examples
"Sales by source"
"Prospects by source last month"
"Leads breakdown by agent"
"Sales by location MTD"
"Accounts split by property type"

// QueryPlan
{
  intent: 'BREAKDOWN',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  group_by: ['source'],
  time_range: { ... }
}
```

### 5️⃣ Conversion Queries

Conversion rates between stages.

**Intent:** `CONVERSION`  
**Metric:** `FUNNEL.CONVERSION`

```typescript
// Examples
"Lead to prospect conversion rate"
"Prospect to sale conversion by source"
"Account to booking conversion MTD"

// QueryPlan
{
  intent: 'CONVERSION',
  metric_ids: ['FUNNEL.CONVERSION'],
  conversion: {
    from_stage: 'LEAD',
    to_stage: 'PROSPECT'
  },
  time_range: { ... }
}
```

### 6️⃣ Drop-off Queries

Identify leakage points in funnel.

**Intent:** `DROPOFF`  
**Metric:** `FUNNEL.DROPOFF`

```typescript
// Examples
"Where is drop-off highest?"
"Leakage after prospects"
"Drop-off analysis MTD"

// QueryPlan
{
  intent: 'DROPOFF',
  metric_ids: ['FUNNEL.DROPOFF'],
  stages: [],
  time_range: { ... }
}
```

### 7️⃣ Velocity Queries

Time between stages (avg, median, p90, p95).

**Intent:** `VELOCITY`  
**Metric:** `FUNNEL.VELOCITY`

```typescript
// Examples
"Avg days lead to sale"
"Median time prospect to account"
"How long lead to booking"
"P90 days account to sale"

// QueryPlan
{
  intent: 'VELOCITY',
  metric_ids: ['FUNNEL.VELOCITY'],
  velocity: {
    from_stage: 'LEAD',
    to_stage: 'SALE',
    aggregation: 'avg'
  },
  time_range: { ... }
}
```

### 8️⃣ Aging Queries

Records stuck in stage beyond threshold.

**Intent:** `AGING`  
**Metric:** `FUNNEL.AGING`

```typescript
// Examples
"Prospects older than 14 days"
"Accounts stuck more than 30 days"
"Leads older than 7 days"
"Stale prospects 60 days"

// QueryPlan
{
  intent: 'AGING',
  metric_ids: ['FUNNEL.AGING'],
  aging: {
    stage: 'PROSPECT',
    threshold_days: 14,
    operator: '>'
  },
  time_range: { ... }
}
```

### 9️⃣ Comparison Queries

Period-over-period analysis (WoW, MoM, YoY, etc.).

**Intent:** `COMPARISON`  
**Metric:** Stage metric  
**Comparison:** ComparisonSpec

```typescript
// Examples
"Sales MTD vs last month"
"WoW leads"
"Month over month sales"
"YoY prospects"
"Accounts this quarter vs last quarter"

// QueryPlan
{
  intent: 'COMPARISON',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  comparison: {
    type: 'MoM',
    base_range: { ... },
    compare_range: { ... }
  },
  time_range: { ... }
}
```

### 🔟 Ranking Queries

Top/bottom N by metric.

**Intent:** `RANKING`  
**Metric:** Stage metric  
**Ranking:** RankingSpec

```typescript
// Examples
"Top 10 sources by sales"
"Bottom 5 agents by leads"
"Top sources by prospects MTD"
"Best performing locations by sales"

// QueryPlan
{
  intent: 'RANKING',
  metric_ids: ['FUNNEL.SALES_ENTERED'],
  stages: ['SALE'],
  group_by: ['source'],
  ranking: {
    order_by: 'FUNNEL.SALES_ENTERED',
    direction: 'desc',
    limit: 10
  },
  time_range: { ... }
}
```

## Stage Term Normalization

The resolver recognizes multiple synonyms for each stage:

| Stage | Synonyms |
|-------|----------|
| **LEAD** | lead, leads, enquiry, enquiries, inquiry, inquiries |
| **PROSPECT** | prospect, prospects, qualified |
| **ACCOUNT** | account, accounts, onboarded |
| **SALE** | sale, sales, won, booking, bookings, deal, deals, maal_laao, "maal laao" |

## Time Range Handling

**All time expressions are delegated to the existing TimeRangeResolver.**

Supported expressions:
- To-date: WTD, MTD, QTD, YTD, FYTD
- Calendar: this/last/next week/month/quarter/year
- Rolling: last N days/weeks/months
- Explicit: between X and Y, from X to Y
- Open-ended: since X, until X
- Comparison: WoW, MoM, QoQ, YoY, DoD

See `time-range/README.md` for complete time-range documentation.

## API Usage

### Basic Usage

```typescript
import { resolveNLQ } from './nlq-resolver';

// Simple query
const plan = resolveNLQ('Leads MTD');

// With configuration
const plan = resolveNLQ('Sales last 30 days', {
  timezone: 'Asia/Kolkata',
  fiscal_config: { fiscal_year_start_month: 4 },
  week_start: 'monday',
  now: '2026-02-09T12:00:00+05:30' // For testing
});

console.log(plan);
// {
//   intent: 'STAGE_METRIC',
//   metric_ids: ['FUNNEL.SALES_ENTERED'],
//   stages: ['SALE'],
//   time_range: { start: '...', end: '...', ... },
//   original_query: 'Sales last 30 days',
//   confidence: 0.9
// }
```

### Integration with SQL Builder

```typescript
import { resolveNLQ } from './nlq-resolver';
import { SQLBuilder } from './sql-builder'; // Your existing SQL builder
import { MetricRegistry } from './metric-registry'; // Your existing registry

// 1. Resolve NLQ to QueryPlan
const plan = resolveNLQ('Top 10 sources by sales MTD');

// 2. Get metric schemas from registry
const metrics = plan.metric_ids.map(id => MetricRegistry.get(id));

// 3. Build SQL using existing builder
const sql = SQLBuilder.build({
  metrics,
  time_range: plan.time_range,
  group_by: plan.group_by,
  ranking: plan.ranking
});

// 4. Execute query
const results = await db.query(sql);
```

### Tokenization & Intent Detection

```typescript
import { tokenize, detectIntent } from './nlq-resolver';

// Tokenize query
const tokens = tokenize('Top 10 sources by sales MTD');
console.log(tokens);
// {
//   stages: ['SALE'],
//   time_expressions: ['mtd'],
//   dimensions: ['source'],
//   numbers: [10],
//   comparison_keywords: [],
//   aggregation_keywords: [],
//   tokens: ['top', '10', 'sources', 'by', 'sales', 'mtd']
// }

// Detect intent
const intent = detectIntent('Top 10 sources by sales MTD', tokens);
console.log(intent); // 'RANKING'
```

## Dimensions

Supported breakdown dimensions:

| Dimension | Keywords |
|-----------|----------|
| **source** | source, sources, channel, channels, origin |
| **agent** | agent, agents, rep, reps, sales rep, salesperson |
| **location** | location, locations, city, cities, region, regions |
| **property_type** | property type, property types, type, types |
| **stage** | stage, stages, status |

## Confidence Scoring

The resolver calculates a confidence score (0-1) based on:
- Detected stages (+0.2)
- Time expressions (+0.2)
- Clear intent keywords (+0.1)

Base confidence: 0.5

## Testing

Run the comprehensive test suite with 40+ test cases:

```bash
npm test src/nlq-resolver/__tests__/parser.test.ts
```

### Test Coverage

- ✅ All 10 intent types
- ✅ All 4 funnel stages
- ✅ All stage synonyms (enquiries, bookings, maal laao, etc.)
- ✅ All time range types (MTD, WTD, YTD, rolling, calendar, comparison)
- ✅ All dimensions (source, agent, location, property type)
- ✅ Ranking queries (top/bottom N)
- ✅ Conversion, velocity, aging queries
- ✅ Edge cases (multiple dimensions, FYTD, confidence scoring)

## Examples by Use Case

### Sales Dashboard

```typescript
// Funnel overview
resolveNLQ('Show funnel MTD');

// MTD vs last month
resolveNLQ('Sales MTD vs last month');

// Breakdown by source
resolveNLQ('Sales by source MTD');

// Top performers
resolveNLQ('Top 10 sources by sales');
```

### Trend Analysis

```typescript
// Daily trend
resolveNLQ('Daily leads last 14 days');

// Weekly trend
resolveNLQ('Weekly sales MTD');

// Monthly trend
resolveNLQ('Monthly prospects YTD');
```

### Conversion Funnel

```typescript
// Conversion rate
resolveNLQ('Lead to prospect conversion rate');

// By source
resolveNLQ('Prospect to sale conversion by source');

// Drop-off analysis
resolveNLQ('Where is drop-off highest?');
```

### Performance Metrics

```typescript
// Velocity
resolveNLQ('Avg days lead to sale');

// Aging
resolveNLQ('Prospects older than 14 days');

// Comparisons
resolveNLQ('WoW leads');
resolveNLQ('YoY sales');
```

## Extending the Resolver

### Adding New Intent

1. Add intent type to `types.ts`:
```typescript
export type QueryIntent = 
  | 'STAGE_METRIC'
  | 'NEW_INTENT'  // Add here
  | ...
```

2. Add keywords to `INTENT_KEYWORDS`:
```typescript
export const INTENT_KEYWORDS = {
  NEW_INTENT: ['keyword1', 'keyword2'],
  ...
}
```

3. Add detection logic in `detectIntent()` function
4. Add metric resolution in `resolveMetricIds()` function
5. Add intent-specific handling in `resolveNLQ()` switch statement
6. Add tests

### Adding New Stage Term

Add to `STAGE_TERMS` in `types.ts`:

```typescript
export const STAGE_TERMS: Record<FunnelStage, string[]> = {
  LEAD: ['lead', 'leads', 'enquiry', 'new_term'],
  ...
}
```

### Adding New Dimension

1. Add to `DimensionType`:
```typescript
export type DimensionType = 
  | 'source'
  | 'new_dimension'
  | ...
```

2. Add keywords to `DIMENSION_KEYWORDS`:
```typescript
export const DIMENSION_KEYWORDS: Record<DimensionType, string[]> = {
  new_dimension: ['keyword1', 'keyword2'],
  ...
}
```

## Architecture Diagram

```
┌──────────────┐
│   NLQ Text   │
└──────┬───────┘
       │
       ▼
┌──────────────────────┐
│    Tokenizer         │
│  (extract stages,    │
│   time, dimensions)  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│  Intent Detector     │
│  (10 intent types)   │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ TimeRangeResolver    │ ← Existing module
│  (MTD, WTD, etc.)    │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│  Metric Resolver     │
│ (map to metric IDs)  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│    QueryPlan         │ → SQL Builder
│  (output contract)   │ → MetricRegistry
└──────────────────────┘
```

## Dependencies

- `time-range` module: For time expression resolution
- Existing `MetricRegistry`: For metric schema lookup
- Existing `SQLBuilder`: For SQL generation (downstream)

## Limitations

1. **Single intent per query**: Complex queries with multiple intents are not supported
2. **English only**: No multi-language support
3. **Keyword-based**: Not ML-powered, relies on pattern matching
4. **No context memory**: Each query is independent

## Future Enhancements

- [ ] Multi-intent query support
- [ ] Natural language filters ("high-value leads", "active prospects")
- [ ] Fuzzy matching for typos
- [ ] Query suggestions based on partial input
- [ ] ML-based intent classification
- [ ] Multi-language support

## License

Part of lohono-db-context MCP server project.
