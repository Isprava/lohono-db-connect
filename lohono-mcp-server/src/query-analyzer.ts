/**
 * SQL Query Analyzer
 *
 * Extracts business logic patterns from raw SQL queries using regex-based
 * pattern matching. Produces a structured analysis that the rule generator
 * can transform into YAML rules and MCP tool definitions.
 */

// ── Result types ───────────────────────────────────────────────────────────

export interface QueryAnalysis {
  tables: TableRef[];
  joins: JoinRef[];
  ctes: CteRef[];
  aggregations: AggregationRef[];
  date_filters: DateFilterRef[];
  timezone_conversions: TimezoneRef[];
  progressive_filters: string[];
  exclusions: ExclusionRef[];
  case_statements: CaseRef[];
  status_conditions: string[];
  union_structure: boolean;
  window_functions: WindowRef[];
  jsonb_operations: string[];
  distinct_counts: string[];
  parameters: string[];
  structure: "single_table" | "multi_join" | "cte" | "union" | "cte_union";
}

export interface TableRef {
  name: string;
  alias?: string;
  role: "primary" | "joined" | "cte_source" | "subquery";
}

export interface JoinRef {
  type: "JOIN" | "LEFT JOIN" | "RIGHT JOIN" | "CROSS JOIN" | "INNER JOIN";
  table: string;
  alias?: string;
  on_conditions: string[];
}

export interface CteRef {
  name: string;
  sql: string;
  tables: string[];
}

export interface AggregationRef {
  function: string;
  expression: string;
  alias?: string;
  is_distinct: boolean;
}

export interface DateFilterRef {
  column: string;
  pattern: "mtd" | "mtd_last_year" | "trailing_months" | "fixed_start" | "custom";
  sql: string;
  has_timezone: boolean;
}

export interface TimezoneRef {
  column: string;
  interval: string;
  format: "330_minutes" | "5h30m" | "other";
}

export interface ExclusionRef {
  type: "not_in" | "not_equal" | "is_null_check" | "not_like";
  column: string;
  values: string[];
  sql: string;
}

export interface CaseRef {
  sql: string;
  branches: { when: string; then: string }[];
  else_value?: string;
  alias?: string;
}

export interface WindowRef {
  function: string;
  partition_by: string[];
  order_by: string[];
  sql: string;
}

// ── Analyzer ───────────────────────────────────────────────────────────────

export function analyzeQuery(sql: string): QueryAnalysis {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const upper = normalized.toUpperCase();

  return {
    tables: extractTables(normalized),
    joins: extractJoins(normalized),
    ctes: extractCTEs(normalized),
    aggregations: extractAggregations(normalized),
    date_filters: extractDateFilters(normalized),
    timezone_conversions: extractTimezoneConversions(normalized),
    progressive_filters: extractProgressiveFilters(normalized),
    exclusions: extractExclusions(normalized),
    case_statements: extractCaseStatements(normalized),
    status_conditions: extractStatusConditions(normalized),
    union_structure: /\bUNION\b/i.test(upper),
    window_functions: extractWindowFunctions(normalized),
    jsonb_operations: extractJsonbOps(normalized),
    distinct_counts: extractDistinctCounts(normalized),
    parameters: extractParameters(normalized),
    structure: detectStructure(upper),
  };
}

// ── Extractors ─────────────────────────────────────────────────────────────

function extractTables(sql: string): TableRef[] {
  const tables: TableRef[] = [];
  const seen = new Set<string>();

  // FROM table [AS] alias
  const fromRe = /\bFROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  for (const m of sql.matchAll(fromRe)) {
    const name = m[1].toLowerCase();
    if (!isKeyword(name) && !seen.has(name)) {
      seen.add(name);
      tables.push({ name, alias: m[2]?.toLowerCase(), role: "primary" });
    }
  }

  // JOIN table [AS] alias
  const joinRe = /\bJOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  for (const m of sql.matchAll(joinRe)) {
    const name = m[1].toLowerCase();
    if (!isKeyword(name) && !seen.has(name)) {
      seen.add(name);
      tables.push({ name, alias: m[2]?.toLowerCase(), role: "joined" });
    }
  }

  return tables;
}

function extractJoins(sql: string): JoinRef[] {
  const joins: JoinRef[] = [];
  // Match: [LEFT|RIGHT|INNER|CROSS] JOIN table [AS alias] ON conditions
  const re =
    /\b(LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+ON\s+(.*?)(?=\bLEFT\b|\bRIGHT\b|\bINNER\b|\bCROSS\b|\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\)|\bHAVING\b|$)/gi;

  for (const m of sql.matchAll(re)) {
    const type = m[1].replace(/\s+/g, " ").toUpperCase() as JoinRef["type"];
    const table = m[2].toLowerCase();
    const alias = m[3]?.toLowerCase();
    const onClause = m[4].trim().replace(/\s+/g, " ");
    const on_conditions = onClause
      .split(/\s+AND\s+/i)
      .map((c) => c.trim())
      .filter(Boolean);

    if (!isKeyword(table)) {
      joins.push({ type, table, alias, on_conditions });
    }
  }

  return joins;
}

function extractCTEs(sql: string): CteRef[] {
  const ctes: CteRef[] = [];
  // Match WITH name AS (...)
  const re = /\bWITH\s+/gi;
  if (!re.test(sql)) return ctes;

  // Extract individual CTEs: name AS ( ... )
  const cteRe = /(\w+)\s+AS\s*\(/gi;
  const upper = sql.toUpperCase();

  for (const m of sql.matchAll(cteRe)) {
    const name = m[1].toLowerCase();
    if (name === "date" || isKeyword(name)) continue;

    // Find the balanced parentheses content
    const startIdx = m.index! + m[0].length - 1; // position of opening (
    const cteSql = extractParenContent(sql, startIdx);

    // Extract tables referenced in CTE
    const innerTables: string[] = [];
    const fromRe2 = /\bFROM\s+(\w+)/gi;
    for (const fm of cteSql.matchAll(fromRe2)) {
      const t = fm[1].toLowerCase();
      if (!isKeyword(t)) innerTables.push(t);
    }

    ctes.push({ name, sql: cteSql.trim(), tables: innerTables });
  }

  return ctes;
}

function extractAggregations(sql: string): AggregationRef[] {
  const aggs: AggregationRef[] = [];
  // Match: AGG_FUNC([DISTINCT] expr) [AS alias]
  const re =
    /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?(.*?)\)\s*(?:(?:::?\w+\s*)*)(?:\s+(?:AS\s+)?(\w+))?/gi;

  for (const m of sql.matchAll(re)) {
    aggs.push({
      function: m[1].toUpperCase(),
      expression: (m[2] || "").trim() + m[3].trim(),
      alias: m[4]?.toLowerCase(),
      is_distinct: !!m[2],
    });
  }

  return aggs;
}

function extractDateFilters(sql: string): DateFilterRef[] {
  const filters: DateFilterRef[] = [];

  // MTD current: date_trunc('month', CURRENT_DATE ...)
  const mtdRe =
    /(\w+[\w.]*)\s*[\+\s]*interval\s+'[^']+'\s*\)?\s*::?\s*date\s*>=\s*.*?date_trunc\s*\(\s*'month'\s*,\s*CURRENT_DATE/gi;
  for (const m of sql.matchAll(mtdRe)) {
    filters.push({
      column: m[1],
      pattern: "mtd",
      sql: m[0].trim(),
      has_timezone: /interval/i.test(m[0]),
    });
  }

  // Trailing N months: interval 'N months'
  const trailingRe =
    /date_trunc\s*\(\s*'month'\s*,\s*CURRENT_DATE\s*\)\s*-\s*interval\s+'(\d+)\s*months?'/gi;
  for (const m of sql.matchAll(trailingRe)) {
    filters.push({
      column: "derived",
      pattern: "trailing_months",
      sql: m[0].trim(),
      has_timezone: false,
    });
  }

  // Fixed start date: >= 'YYYY-MM-DD'
  const fixedRe =
    /(\w+[\w.]*)\s*.*?>=\s*'(\d{4}-\d{2}-\d{2})'/gi;
  for (const m of sql.matchAll(fixedRe)) {
    filters.push({
      column: m[1],
      pattern: "fixed_start",
      sql: m[0].trim(),
      has_timezone: /interval/i.test(m[0]),
    });
  }

  // Last year: CURRENT_DATE - interval '1 year'
  if (/CURRENT_DATE\s*-\s*interval\s+'1\s*year'/i.test(sql)) {
    filters.push({
      column: "derived",
      pattern: "mtd_last_year",
      sql: "CURRENT_DATE - interval '1 year'",
      has_timezone: true,
    });
  }

  return filters;
}

function extractTimezoneConversions(sql: string): TimezoneRef[] {
  const convs: TimezoneRef[] = [];
  // Match: column + interval '330 minutes' or '5 hours 30 minutes'
  const re =
    /(\w+[\w.]*)\s*\+\s*interval\s+'([^']+)'/gi;

  for (const m of sql.matchAll(re)) {
    const interval = m[2].trim();
    let format: TimezoneRef["format"] = "other";
    if (/330\s*minutes/i.test(interval)) format = "330_minutes";
    else if (/5\s*hours?\s*30\s*minutes/i.test(interval)) format = "5h30m";

    convs.push({ column: m[1], interval, format });
  }

  return convs;
}

function extractProgressiveFilters(sql: string): string[] {
  const filters: string[] = [];
  const re = /date_part\s*\(\s*'day'\s*,\s*([^)]+)\)\s*<=\s*date_part\s*\(\s*'day'\s*,\s*([^)]+)\)/gi;
  for (const m of sql.matchAll(re)) {
    filters.push(m[0].trim());
  }
  return filters;
}

function extractExclusions(sql: string): ExclusionRef[] {
  const exclusions: ExclusionRef[] = [];

  // NOT IN ('val1', 'val2', ...)
  const notInRe = /(\w+[\w.]*)\s+NOT\s+IN\s*\(\s*('[^)]+?')\s*\)/gi;
  for (const m of sql.matchAll(notInRe)) {
    const values = m[2].match(/'([^']+)'/g)?.map((v) => v.replace(/'/g, "")) ?? [];
    exclusions.push({
      type: "not_in",
      column: m[1],
      values,
      sql: m[0].trim(),
    });
  }

  // column != 'value'
  const neqRe = /(\w+[\w.]*)\s*!=\s*'([^']+)'/gi;
  for (const m of sql.matchAll(neqRe)) {
    exclusions.push({
      type: "not_equal",
      column: m[1],
      values: [m[2]],
      sql: m[0].trim(),
    });
  }

  // NOT LIKE pattern
  const notLikeRe = /(\w+[\w.]*)\s+NOT\s+LIKE\s+'([^']+)'/gi;
  for (const m of sql.matchAll(notLikeRe)) {
    exclusions.push({
      type: "not_like",
      column: m[1],
      values: [m[2]],
      sql: m[0].trim(),
    });
  }

  return exclusions;
}

function extractCaseStatements(sql: string): CaseRef[] {
  const cases: CaseRef[] = [];
  // Find CASE ... END blocks
  const re = /CASE\s+(.*?)\s+END(?:\s+(?:AS\s+)?(\w+))?/gis;

  for (const m of sql.matchAll(re)) {
    const body = m[1];
    const alias = m[2]?.toLowerCase();
    const branches: { when: string; then: string }[] = [];

    const whenRe = /WHEN\s+(.*?)\s+THEN\s+'?([^']*?)'?(?=\s+WHEN|\s+ELSE|\s*$)/gis;
    for (const wm of body.matchAll(whenRe)) {
      branches.push({ when: wm[1].trim(), then: wm[2].trim() });
    }

    let else_value: string | undefined;
    const elseRe = /ELSE\s+'?([^']*?)'?\s*$/i;
    const elseMatch = body.match(elseRe);
    if (elseMatch) else_value = elseMatch[1].trim();

    cases.push({ sql: m[0].trim(), branches, else_value, alias });
  }

  return cases;
}

function extractStatusConditions(sql: string): string[] {
  const conditions: string[] = [];

  // status = 'value' or status != 'value'
  const re = /\bstatus\s*[!=<>]+\s*'[^']+'/gi;
  for (const m of sql.matchAll(re)) {
    conditions.push(m[0].trim());
  }

  // IS NULL / IS NOT NULL for key columns
  const nullRe = /(\w+_at)\s+IS\s+(NOT\s+)?NULL/gi;
  for (const m of sql.matchAll(nullRe)) {
    conditions.push(m[0].trim());
  }

  // is_trash checks
  const trashRe = /\bis_trash\s*[!=<>]+\s*(TRUE|FALSE|'[^']+')/gi;
  for (const m of sql.matchAll(trashRe)) {
    conditions.push(m[0].trim());
  }

  return conditions;
}

function extractWindowFunctions(sql: string): WindowRef[] {
  const windows: WindowRef[] = [];
  const re =
    /(RANK|ROW_NUMBER|DENSE_RANK|LEAD|LAG|NTILE)\s*\(\s*\)\s*OVER\s*\(\s*(.*?)\)/gis;

  for (const m of sql.matchAll(re)) {
    const func = m[1].toUpperCase();
    const overClause = m[2].trim();

    const partitionMatch = overClause.match(/PARTITION\s+BY\s+(.*?)(?=\s+ORDER|\s*$)/i);
    const orderMatch = overClause.match(/ORDER\s+BY\s+(.*?)$/i);

    const partition_by = partitionMatch
      ? partitionMatch[1].split(",").map((s) => s.trim())
      : [];
    const order_by = orderMatch
      ? orderMatch[1].split(",").map((s) => s.trim())
      : [];

    windows.push({ function: func, partition_by, order_by, sql: m[0].trim() });
  }

  return windows;
}

function extractJsonbOps(sql: string): string[] {
  const ops: string[] = [];
  const re = /jsonb_array_elements\s*\([^)]+\)\s*(?:->>?\s*'[^']+')?/gi;
  for (const m of sql.matchAll(re)) {
    ops.push(m[0].trim());
  }
  return ops;
}

function extractDistinctCounts(sql: string): string[] {
  const counts: string[] = [];
  const re = /COUNT\s*\(\s*DISTINCT\s*\(?([^)]+)\)?\s*\)/gi;
  for (const m of sql.matchAll(re)) {
    counts.push(m[1].trim());
  }
  return counts;
}

function extractParameters(sql: string): string[] {
  const params: string[] = [];
  const re = /\$(\d+)/g;
  for (const m of sql.matchAll(re)) {
    if (!params.includes(m[0])) params.push(m[0]);
  }
  return params;
}

function detectStructure(
  upper: string
): QueryAnalysis["structure"] {
  const hasCTE = /\bWITH\b/.test(upper);
  const hasUnion = /\bUNION\b/.test(upper);
  const hasJoin = /\bJOIN\b/.test(upper);

  if (hasCTE && hasUnion) return "cte_union";
  if (hasCTE) return "cte";
  if (hasUnion) return "union";
  if (hasJoin) return "multi_join";
  return "single_table";
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "on", "as",
  "join", "left", "right", "inner", "outer", "cross", "full",
  "group", "order", "by", "having", "limit", "offset", "union",
  "all", "distinct", "case", "when", "then", "else", "end",
  "with", "recursive", "insert", "update", "delete", "create",
  "alter", "drop", "table", "index", "view", "true", "false",
  "null", "is", "between", "like", "ilike", "exists", "any",
  "asc", "desc", "cast", "interval", "date", "timestamp",
  "current_date", "current_timestamp", "now", "generate_series",
  "lateral", "filter", "over", "partition", "row_number", "rank",
]);

function isKeyword(word: string): boolean {
  return SQL_KEYWORDS.has(word.toLowerCase());
}

function extractParenContent(sql: string, openIdx: number): string {
  let depth = 0;
  let i = openIdx;
  for (; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return sql.substring(openIdx + 1, i);
}
