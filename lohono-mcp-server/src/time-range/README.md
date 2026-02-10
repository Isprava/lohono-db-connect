# Time Range NLQ Parser

Deterministic Natural Language Query (NLQ) time-range interpretation for the lohono-db-context MCP server.

## Overview

Converts natural language time expressions into canonical TimeRange objects that can be used by downstream SQL builders. All interpretations are deterministic and timezone-aware.

## Features

- **Deterministic**: Same input always produces same output for given reference time
- **Timezone-aware**: All calculations respect timezone boundaries (default: Asia/Kolkata)
- **SQL-safe**: Produces exclusive end boundaries (`WHERE timestamp >= start AND timestamp < end`)
- **Comprehensive**: Supports 6 categories of time expressions
- **Configurable**: Fiscal year, week start, and timezone configuration

## Supported Time Expressions

### 1. To-Date Expressions

Returns from start of period to current moment.

| Expression | Abbreviation | Description | Example Output (Feb 9, 2026) |
|------------|--------------|-------------|------------------------------|
| Week to Date | WTD | Monday to now | 2026-02-09 00:00 to 2026-02-09 12:00 |
| Month to Date | MTD | 1st of month to now | 2026-02-01 00:00 to 2026-02-09 12:00 |
| Quarter to Date | QTD | Start of quarter to now | 2026-01-01 00:00 to 2026-02-09 12:00 |
| Year to Date | YTD | Jan 1 to now | 2026-01-01 00:00 to 2026-02-09 12:00 |
| Fiscal Year to Date | FYTD | Fiscal year start to now | 2025-04-01 00:00 to 2026-02-09 12:00 |
| Period to Date | PTD | Alias for MTD | Same as MTD |

**Usage:**
```typescript
resolveTimeRange('MTD', config);
resolveTimeRange('year to date', config);
```

### 2. Calendar-Aligned Expressions

Returns complete calendar periods.

| Expression | Description | Example Output (Feb 9, 2026) |
|------------|-------------|------------------------------|
| this week | Current week (Mon-Sun) | 2026-02-09 to 2026-02-16 |
| this month | Current month | 2026-02-01 to 2026-03-01 |
| this quarter | Current quarter | 2026-01-01 to 2026-04-01 |
| this year | Current year | 2026-01-01 to 2027-01-01 |
| last week | Previous week | 2026-02-02 to 2026-02-09 |
| last month | Previous month | 2026-01-01 to 2026-02-01 |
| last quarter | Previous quarter | 2025-10-01 to 2026-01-01 |
| last year | Previous year | 2025-01-01 to 2026-01-01 |
| next week | Following week | 2026-02-16 to 2026-02-23 |
| next month | Following month | 2026-03-01 to 2026-04-01 |

**Synonyms:** "current", "previous", "prior" are normalized to "this"/"last"

**Usage:**
```typescript
resolveTimeRange('this month', config);
resolveTimeRange('last quarter', config);
```

### 3. Rolling Window Expressions

Returns N units backward from now.

| Expression | Abbreviation | Description | Example Output (Feb 9, 2026) |
|------------|--------------|-------------|------------------------------|
| last 7 days | L7D | 7 days before now | 2026-02-02 12:00 to 2026-02-09 12:00 |
| last 30 days | L30D | 30 days before now | 2026-01-10 12:00 to 2026-02-09 12:00 |
| last 90 days | L90D | 90 days before now | 2025-11-11 12:00 to 2026-02-09 12:00 |
| last 12 months | L12M | 12 months before now | 2025-02-09 12:00 to 2026-02-09 12:00 |
| last 4 weeks | L4W | 4 weeks before now | 2026-01-12 12:00 to 2026-02-09 12:00 |
| last N quarters | - | N quarters before now | Calculated dynamically |
| last N years | - | N years before now | Calculated dynamically |

**Synonyms:** "past", "trailing" are normalized to "last"

**Usage:**
```typescript
resolveTimeRange('last 7 days', config);
resolveTimeRange('L30D', config);
resolveTimeRange('past 90 days', config);
```

### 4. Explicit Date Range Expressions

Returns range between two specified dates.

**Formats:**
- `between [date1] and [date2]`
- `from [date1] to [date2]`

**Date Formats:**
- ISO: `2026-01-01`
- Month names: `Jan 1`, `January 15, 2026`
- Relative: `yesterday`, `today`, `tomorrow`

**Usage:**
```typescript
resolveTimeRange('between 2026-01-01 and 2026-01-31', config);
resolveTimeRange('from Jan 1 to Jan 31', config);
resolveTimeRange('between yesterday and today', config);
```

### 5. Open-Ended Expressions

Returns ranges with one boundary undefined.

| Expression | Description | Output |
|------------|-------------|--------|
| since [date] | From date to infinity | start: date, end: null |
| after [date] | After date to infinity | start: date, end: null |
| until [date] | From beginning to date | start: null, end: date |
| before [date] | Before date | start: null, end: date |
| up to [date] | Up to date | start: null, end: date |

**Usage:**
```typescript
resolveTimeRange('since 2026-01-01', config);
resolveTimeRange('until tomorrow', config);
```

### 6. Comparison Expressions

Returns base period and comparison period for period-over-period analysis.

| Expression | Abbreviation | Description | Base Period | Compare Period |
|------------|--------------|-------------|-------------|----------------|
| Day over Day | DoD | Current day vs yesterday | Today | Yesterday |
| Week over Week | WoW | Current week vs last week | This week | Last week |
| Month over Month | MoM | Current month vs last month | This month | Last month |
| Quarter over Quarter | QoQ | Current quarter vs last quarter | This quarter | Last quarter |
| Year over Year | YoY | Current year vs last year | This year | Last year |
| Same Period Last Year | SPLY | Current period vs same last year | Current period | Same period -1 year |

**Usage:**
```typescript
const result = resolveTimeRange('MoM', config);
console.log(result.comparison.base_range);    // February 2026
console.log(result.comparison.compare_range); // January 2026
```

## API Reference

### Main Functions

#### `resolveTimeRange(text: string, config?: TimeRangeConfig): TimeRange`

Parses natural language time expression into canonical TimeRange object.

**Parameters:**
- `text`: Natural language time expression
- `config`: Optional configuration (timezone, fiscal year, etc.)

**Returns:** TimeRange object with start/end dates

**Example:**
```typescript
import { resolveTimeRange } from './time-range';

const result = resolveTimeRange('MTD', {
  timezone: 'Asia/Kolkata',
  fiscal_config: { fiscal_year_start_month: 4 },
  week_start: 'monday',
  now: '2026-02-09T12:00:00+05:30' // For testing
});

console.log(result);
// {
//   mode: 'to_date',
//   start: '2026-02-01T00:00:00+05:30',
//   end: '2026-02-09T12:00:00+05:30',
//   timezone: 'Asia/Kolkata',
//   granularity: 'month',
//   calendar_week_start: 'monday',
//   fiscal_year_start_month: 4,
//   original_text: 'mtd'
// }
```

#### `normalize(text: string): string`

Normalizes input text for parsing.

**Transformations:**
- Converts to lowercase
- Expands abbreviations (WTD → week to date)
- Normalizes synonyms (current → this, previous → last)
- Handles hyphenated terms (week-to-date → week to date)

**Example:**
```typescript
normalize('WTD'); // 'week to date'
normalize('previous month'); // 'last month'
normalize('L7D'); // 'last 7 days'
```

#### `detectTimeTerms(text: string): DetectedTimeTerm[]`

Detects and classifies time terms in text.

**Returns:** Array of detected terms with type, position, and confidence

**Example:**
```typescript
const terms = detectTimeTerms('show me MTD sales data');
// [{ token: 'month to date', type: 'to_date', confidence: 1.0, ... }]
```

## Configuration

### TimeRangeConfig

```typescript
interface TimeRangeConfig {
  timezone: string;              // IANA timezone (default: 'Asia/Kolkata')
  fiscal_config: FiscalConfig;   // Fiscal year settings
  week_start: WeekStart;         // 'monday' | 'sunday' (default: 'monday')
  now?: Date | string;           // Reference time (default: current time)
}

interface FiscalConfig {
  fiscal_year_start_month: number; // 1-12 (default: 4 for April)
  fiscal_year_label?: string;      // Display label (default: 'FY')
}
```

### Default Configuration

```typescript
const DEFAULT_CONFIG = {
  timezone: 'Asia/Kolkata',
  fiscal_config: {
    fiscal_year_start_month: 4, // April start
    fiscal_year_label: 'FY'
  },
  week_start: 'monday'
};
```

## TimeRange Schema

```typescript
interface TimeRange {
  mode: TimeRangeMode;           // Type of time range
  start: string | null;          // ISO 8601 start (inclusive)
  end: string | null;            // ISO 8601 end (exclusive)
  timezone: string;              // IANA timezone
  granularity: TimeGranularity;  // day, week, month, quarter, year
  calendar_week_start: WeekStart;
  fiscal_year_start_month: number;
  comparison?: ComparisonRange;  // For comparison expressions
  original_text?: string;        // Original input
}
```

## Deterministic Rules

### Timezone Boundaries

All date calculations respect timezone boundaries. When converting "2026-02-09" to a Date object:
- Start of day: `2026-02-09T00:00:00+05:30`
- End of day: `2026-02-10T00:00:00+05:30` (exclusive)

### Exclusive End Boundaries

All ranges use **exclusive end boundaries** for SQL safety:

```sql
-- Correct usage
WHERE timestamp >= '2026-02-01T00:00:00+05:30' 
  AND timestamp < '2026-03-01T00:00:00+05:30'
  
-- This captures all of February without overlap
```

### Week Start

- Default: **Monday** (ISO 8601 standard)
- Configurable to Sunday for US-style weeks
- Affects: WTD, "this week", "last week", WoW

### Fiscal Year

- Default: **April 1st** (common in India)
- Configurable to any month (1-12)
- Affects: FYTD, fiscal year calculations
- Example: FY2025-26 runs from Apr 1, 2025 to Mar 31, 2026

### Calendar Quarters

- Q1: January - March
- Q2: April - June
- Q3: July - September
- Q4: October - December

## Edge Cases

### Month Boundaries

Handled correctly when day doesn't exist in target month:

```typescript
// Jan 31 + 1 month = Feb 28/29 (not Mar 3)
addMonths('2026-01-31', 1) → '2026-02-28'
```

### Leap Years

Automatically detected and handled:

```typescript
// Feb 29, 2024 is valid (2024 is leap year)
resolveTimeRange('this month', { now: '2024-02-29T12:00:00+05:30' })
// start: 2024-02-01, end: 2024-03-01
```

### Week Calculations

Week boundaries depend on `week_start` configuration:

```typescript
// Monday start (default)
'this week' on Feb 9, 2026 (Monday) → Feb 9-15

// Sunday start
'this week' on Feb 9, 2026 (Monday) → Feb 8-14
```

### Fiscal Year Crossing

Fiscal year determined by current month vs fiscal start month:

```typescript
// Fiscal year starts April
// Current: Feb 2026 (before April) → FY started Apr 2025
// Current: May 2026 (after April) → FY started Apr 2026
```

## SQL Integration

### Basic Usage

```typescript
const range = resolveTimeRange('MTD', config);

const sql = `
  SELECT COUNT(*) as count
  FROM leads
  WHERE enquired_at >= $1 
    AND enquired_at < $2
`;

const result = await query(sql, [range.start, range.end]);
```

### Comparison Queries

```typescript
const range = resolveTimeRange('MoM', config);

const sql = `
  SELECT 
    (SELECT COUNT(*) FROM leads 
     WHERE enquired_at >= $1 AND enquired_at < $2) as current_month,
    (SELECT COUNT(*) FROM leads 
     WHERE enquired_at >= $3 AND enquired_at < $4) as last_month
`;

const result = await query(sql, [
  range.comparison.base_range.start,
  range.comparison.base_range.end,
  range.comparison.compare_range.start,
  range.comparison.compare_range.end
]);
```

### Open-Ended Queries

```typescript
// Since date (start defined, end null)
const range = resolveTimeRange('since 2026-01-01', config);
const sql = `SELECT * FROM leads WHERE enquired_at >= $1`;

// Until date (start null, end defined)
const range = resolveTimeRange('until 2026-12-31', config);
const sql = `SELECT * FROM leads WHERE enquired_at < $1`;
```

## Testing

Comprehensive test suite with golden tests using reference date: **2026-02-09T12:00:00+05:30** (Monday)

Run tests:
```bash
npm test src/time-range/__tests__/parser.test.ts
```

### Test Coverage

- ✅ All 6 expression categories
- ✅ Abbreviation expansion
- ✅ Synonym normalization
- ✅ Month boundaries (Jan 31)
- ✅ Leap years (Feb 29)
- ✅ Week start (Monday/Sunday)
- ✅ Fiscal year crossing
- ✅ Timezone handling
- ✅ SQL integration patterns

## Examples

### Common Use Cases

```typescript
// Sales dashboard: MTD vs last month
const mtd = resolveTimeRange('MTD');
const lastMonth = resolveTimeRange('last month');

// Trend analysis: last 90 days
const trend = resolveTimeRange('last 90 days');

// YoY comparison
const yoy = resolveTimeRange('YoY');
const current = yoy.comparison.base_range;
const previous = yoy.comparison.compare_range;

// Fiscal reporting
const fytd = resolveTimeRange('FYTD', {
  fiscal_config: { fiscal_year_start_month: 4 }
});

// Custom date range
const custom = resolveTimeRange('between Jan 1 and Mar 31');
```

### Integration with MCP Server

```typescript
// In schema-rules.ts or query builder
import { resolveTimeRange } from './time-range';

function buildLeadQuery(timeExpression: string) {
  const range = resolveTimeRange(timeExpression, {
    timezone: 'Asia/Kolkata',
    fiscal_config: { fiscal_year_start_month: 4 },
    week_start: 'monday'
  });
  
  return {
    query: `
      SELECT * FROM leads
      WHERE enquired_at >= $1 AND enquired_at < $2
    `,
    params: [range.start, range.end]
  };
}

// Usage
const { query, params } = buildLeadQuery('MTD');
```

## Performance

- **Deterministic**: O(1) for most expressions
- **No I/O**: All calculations in-memory
- **Lightweight**: No external dependencies (uses native Date and Intl)
- **Caching-friendly**: Same input → same output for given reference time

## Limitations

1. **Relative dates in explicit ranges**: "between yesterday and tomorrow" requires reference time
2. **Ambiguous month names**: "may" could be month or modal verb (use "May" or context)
3. **Locale-specific formats**: Currently supports ISO and common English formats
4. **No daylight saving time handling**: Uses fixed timezone offsets

## Future Enhancements

- [ ] Support for custom fiscal quarter definitions
- [ ] Week-of-year calculations (ISO week numbers)
- [ ] Business day calculations (excluding weekends/holidays)
- [ ] More natural language variants ("fortnight", "a couple months ago")
- [ ] Locale-specific date formats (DD/MM/YYYY, MM/DD/YYYY)
- [ ] Daylight saving time transitions

## Contributing

When adding new time expressions:

1. Add pattern to `detectTimeTerms()` in `parser.ts`
2. Add resolver function for the pattern
3. Add comprehensive tests to `__tests__/parser.test.ts`
4. Update this README with examples
5. Update type definitions in `types.ts` if needed

## License

Part of lohono-db-context MCP server project.
