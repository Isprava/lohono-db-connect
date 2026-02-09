/**
 * Rule Generator
 *
 * Takes a QueryAnalysis (from query-analyzer.ts) plus user-provided metadata
 * and produces:
 *   1. A YAML rules fragment (query pattern, core rules, date filter, validation checks)
 *   2. An MCP tool definition (JSON Schema)
 *   3. A handler code snippet (TypeScript)
 */

import yaml from "js-yaml";
import type { QueryAnalysis } from "./query-analyzer.js";

// ── Input types ────────────────────────────────────────────────────────────

export interface GenerateInput {
  /** The original SQL query */
  sql: string;
  /** Analysis produced by analyzeQuery() */
  analysis: QueryAnalysis;
  /** Machine-readable name (snake_case) e.g. "prospect_aging" */
  pattern_name: string;
  /** Human-readable description */
  description: string;
  /** Category to file under (e.g. "mtd_aggregate", "aging_reports", or a new one) */
  category: string;
  /** Natural-language keywords users might say to trigger this query */
  intent_keywords?: string[];
  /** Optional section name (default: "sales_funnel") */
  section?: string;
}

// ── Output types ───────────────────────────────────────────────────────────

export interface GenerateOutput {
  yaml_rules: string;
  tool_definition: object;
  handler_code: string;
  summary: GenerateSummary;
}

export interface GenerateSummary {
  pattern_name: string;
  category: string;
  tables: string[];
  core_rules_detected: string[];
  date_filter_type: string;
  has_progressive_filter: boolean;
  has_timezone_conversion: boolean;
  has_slug_exclusions: boolean;
  has_source_exclusions: boolean;
  structure: string;
}

// ── Generator ──────────────────────────────────────────────────────────────

export function generateRules(input: GenerateInput): GenerateOutput {
  const { sql, analysis, pattern_name, description, category, intent_keywords } = input;
  const section = input.section || "sales_funnel";

  const summary = buildSummary(input);
  const yamlObj = buildYaml(input, summary);
  const toolDef = buildToolDefinition(input);
  const handler = buildHandlerCode(input);

  return {
    yaml_rules: yaml.dump(yamlObj, { lineWidth: 120, noRefs: true }),
    tool_definition: toolDef,
    handler_code: handler,
    summary,
  };
}

// ── Summary builder ────────────────────────────────────────────────────────

function buildSummary(input: GenerateInput): GenerateSummary {
  const { analysis, pattern_name, category } = input;

  const coreRules: string[] = [];
  if (analysis.timezone_conversions.length > 0) coreRules.push("timezone_conversion");
  if (analysis.exclusions.some((e) => e.type === "not_in")) coreRules.push("slug_exclusions");
  if (analysis.exclusions.some((e) => e.type === "not_equal" && e.values.includes("DnB")))
    coreRules.push("source_exclusion_dnb");
  if (analysis.distinct_counts.length > 0) coreRules.push("distinct_counting");

  let dateType = "custom";
  if (analysis.date_filters.length > 0) {
    dateType = analysis.date_filters[0].pattern;
  }

  return {
    pattern_name,
    category,
    tables: analysis.tables.map((t) => t.name),
    core_rules_detected: coreRules,
    date_filter_type: dateType,
    has_progressive_filter: analysis.progressive_filters.length > 0,
    has_timezone_conversion: analysis.timezone_conversions.length > 0,
    has_slug_exclusions: analysis.exclusions.some((e) => e.type === "not_in"),
    has_source_exclusions: analysis.exclusions.some(
      (e) => e.type === "not_equal" && e.values.includes("DnB")
    ),
    structure: analysis.structure,
  };
}

// ── YAML builder ───────────────────────────────────────────────────────────

function buildYaml(input: GenerateInput, summary: GenerateSummary): object {
  const { analysis, pattern_name, description, category, intent_keywords } = input;

  // ── Query pattern
  const queryPattern: Record<string, unknown> = {
    category,
    description,
    user_intent_keywords: intent_keywords || [description.toLowerCase()],
    structure: analysis.structure,
    applies_date_filter: mapDateFilter(summary.date_filter_type),
    applies_timezone: summary.has_timezone_conversion,
    applies_progressive_filter: summary.has_progressive_filter,
    applies_slug_exclusions: summary.has_slug_exclusions,
    applies_source_exclusion: summary.has_source_exclusions,
    applies_distinct_counting: analysis.distinct_counts.length > 0,
  };

  // ── Core rules detected
  const coreRules: Record<string, unknown> = {};

  if (summary.has_timezone_conversion) {
    const tzFormats = [...new Set(analysis.timezone_conversions.map((t) => t.format))];
    const columns = [...new Set(analysis.timezone_conversions.map((t) => t.column))];
    coreRules["timezone_conversion"] = {
      description: "Convert timestamps to IST",
      format_used: tzFormats.includes("330_minutes") ? "330 minutes" : "5 hours 30 minutes",
      columns,
      mandatory: true,
    };
  }

  if (summary.has_slug_exclusions) {
    const slugExcl = analysis.exclusions.find((e) => e.type === "not_in");
    coreRules["slug_exclusions"] = {
      description: "Exclude specific slugs",
      values: slugExcl?.values || [],
      column: slugExcl?.column || "slug",
      sql_pattern: slugExcl?.sql || "",
      mandatory: true,
    };
  }

  if (summary.has_source_exclusions) {
    const srcExcl = analysis.exclusions.find(
      (e) => e.type === "not_equal" && e.values.includes("DnB")
    );
    coreRules["source_exclusion"] = {
      description: "Exclude specific source values",
      column: srcExcl?.column || "source",
      values: srcExcl?.values || [],
      sql_pattern: srcExcl?.sql || "",
      mandatory: true,
    };
  }

  if (analysis.distinct_counts.length > 0) {
    coreRules["distinct_counting"] = {
      description: "Use DISTINCT counts to prevent duplicates",
      expressions: analysis.distinct_counts,
      mandatory: true,
    };
  }

  // ── Date filter
  const dateFilter: Record<string, unknown> = {};
  if (analysis.date_filters.length > 0) {
    const df = analysis.date_filters[0];
    dateFilter[mapDateFilter(df.pattern)] = {
      description: `Date filter: ${df.pattern}`,
      column: df.column,
      sql_pattern: df.sql,
      has_timezone: df.has_timezone,
      progressive_day_filter: summary.has_progressive_filter,
    };
    if (summary.has_progressive_filter && analysis.progressive_filters.length > 0) {
      (dateFilter[mapDateFilter(df.pattern)] as Record<string, unknown>).progressive_filter_sql =
        analysis.progressive_filters[0];
    }
  }

  // ── Validation checks
  const validationChecks: object[] = [];

  if (summary.has_timezone_conversion) {
    validationChecks.push({
      id: "timezone_all_timestamps",
      rule: "All timestamp columns have IST conversion",
      check: "Every timestamp reference includes '+ interval' for IST",
    });
  }

  if (summary.has_slug_exclusions) {
    validationChecks.push({
      id: "slug_exclusions_applied",
      rule: "Slug exclusions applied to correct tables",
      check: coreRules["slug_exclusions"]
        ? (coreRules["slug_exclusions"] as Record<string, unknown>).sql_pattern
        : "",
    });
  }

  if (analysis.distinct_counts.length > 0) {
    validationChecks.push({
      id: "distinct_counts_used",
      rule: "DISTINCT counts used for deduplication",
      check: `COUNT(DISTINCT(...)) present for: ${analysis.distinct_counts.join(", ")}`,
    });
  }

  if (summary.has_progressive_filter) {
    validationChecks.push({
      id: "progressive_filter",
      rule: "Progressive day filter included",
      check: "date_part('day', ...) <= date_part('day', now())",
    });
  }

  if (analysis.window_functions.length > 0) {
    validationChecks.push({
      id: "window_function_ranking",
      rule: "Window function with correct partition/order",
      check: analysis.window_functions.map((w) => w.sql).join("; "),
    });
  }

  // ── Joins & tables metadata
  const joinDefinitions = analysis.joins.map((j) => ({
    type: j.type,
    table: j.table,
    alias: j.alias,
    on: j.on_conditions,
  }));

  // ── CASE statements (source mapping, etc.)
  const caseMappings = analysis.case_statements.map((c) => ({
    branches: c.branches.length,
    alias: c.alias,
    else_value: c.else_value,
    sql: c.sql.substring(0, 200) + (c.sql.length > 200 ? "..." : ""),
  }));

  // ── Assemble
  const output: Record<string, unknown> = {
    _generated: {
      note: "Auto-generated by analyze_query + generate_rules. Review and customize before use.",
      pattern_name,
      category,
    },
    query_pattern: { [pattern_name]: queryPattern },
  };

  if (Object.keys(coreRules).length > 0) {
    output.core_rules = coreRules;
  }

  if (Object.keys(dateFilter).length > 0) {
    output.date_filters = dateFilter;
  }

  if (validationChecks.length > 0) {
    output.validation_checks = validationChecks;
  }

  output.tables_used = analysis.tables.map((t) => t.name);

  if (joinDefinitions.length > 0) {
    output.joins = joinDefinitions;
  }

  if (caseMappings.length > 0) {
    output.case_statements = caseMappings;
  }

  if (analysis.status_conditions.length > 0) {
    output.status_conditions = analysis.status_conditions;
  }

  if (analysis.aggregations.length > 0) {
    output.aggregations = analysis.aggregations.map((a) => ({
      function: a.function,
      expression: a.expression,
      is_distinct: a.is_distinct,
      alias: a.alias,
    }));
  }

  if (analysis.window_functions.length > 0) {
    output.window_functions = analysis.window_functions.map((w) => ({
      function: w.function,
      partition_by: w.partition_by,
      order_by: w.order_by,
    }));
  }

  if (analysis.jsonb_operations.length > 0) {
    output.jsonb_operations = analysis.jsonb_operations;
  }

  return output;
}

// ── MCP tool definition builder ────────────────────────────────────────────

function buildToolDefinition(input: GenerateInput): object {
  const { pattern_name, description, analysis } = input;
  const toolName = `run_${pattern_name}`;

  // Detect parameterizable fields from the SQL
  const properties: Record<string, object> = {};
  const required: string[] = [];

  // If there are date filters, offer date override
  if (analysis.date_filters.length > 0) {
    properties["start_date"] = {
      type: "string",
      description: "Optional start date override (YYYY-MM-DD). Defaults to current period.",
    };
    properties["end_date"] = {
      type: "string",
      description: "Optional end date override (YYYY-MM-DD). Defaults to current period.",
    };
  }

  // If there are exclusions, offer a way to toggle them
  if (analysis.exclusions.length > 0) {
    properties["apply_exclusions"] = {
      type: "boolean",
      description: "Whether to apply standard exclusions (default: true)",
    };
  }

  // If there's a limit-like pattern, allow row limit
  properties["limit"] = {
    type: "number",
    description: "Maximum number of rows to return",
  };

  return {
    name: toolName,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

// ── Handler code builder ───────────────────────────────────────────────────

function buildHandlerCode(input: GenerateInput): string {
  const { pattern_name, sql, analysis } = input;
  const toolName = `run_${pattern_name}`;
  const schemaName = toPascalCase(pattern_name) + "InputSchema";

  const hasDateParams = analysis.date_filters.length > 0;
  const hasExclusions = analysis.exclusions.length > 0;

  const lines: string[] = [];

  // Zod schema
  lines.push(`// ── Zod schema for ${toolName} ──`);
  lines.push(`const ${schemaName} = z.object({`);
  if (hasDateParams) {
    lines.push(`  start_date: z.string().optional(),`);
    lines.push(`  end_date: z.string().optional(),`);
  }
  if (hasExclusions) {
    lines.push(`  apply_exclusions: z.boolean().optional().default(true),`);
  }
  lines.push(`  limit: z.number().optional(),`);
  lines.push(`});`);
  lines.push(``);

  // Handler
  lines.push(`// ── Handler for ${toolName} ──`);
  lines.push(`if (name === "${toolName}") {`);
  lines.push(`  const input = ${schemaName}.parse(args);`);
  lines.push(``);
  lines.push(`  const sql = \``);

  // Embed the SQL with minor formatting
  const sqlLines = sql.trim().split("\n");
  for (const line of sqlLines) {
    lines.push(`    ${line.trimEnd()}`);
  }

  lines.push(`  \`;`);
  lines.push(``);
  lines.push(`  const result = await executeReadOnlyQuery(sql);`);
  lines.push(`  return {`);
  lines.push(`    content: [`);
  lines.push(`      { type: "text", text: JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 2) },`);
  lines.push(`    ],`);
  lines.push(`  };`);
  lines.push(`}`);

  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapDateFilter(pattern: string): string {
  switch (pattern) {
    case "mtd":
      return "mtd_current_progressive";
    case "mtd_last_year":
      return "mtd_last_year_progressive";
    case "trailing_months":
      return "trailing_12_months";
    case "fixed_start":
      return "since_fixed_date";
    default:
      return "custom_filter";
  }
}

function toPascalCase(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
