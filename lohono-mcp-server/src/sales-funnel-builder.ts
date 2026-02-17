import { loadSalesFunnelConfig } from "./config-loader.js";
import { SalesFunnelConfig, FunnelStage } from "./sales-funnel-types.js";
import { Vertical } from "../../shared/types/verticals.js";

const config: SalesFunnelConfig = loadSalesFunnelConfig();

/** Result from a query builder — SQL with parameterized placeholders and matching values */
export interface ParameterizedQuery {
  sql: string;
  params: unknown[];
}

/** Expose config for the plugin to read metric keys / metadata */
export function getFunnelConfig(): SalesFunnelConfig {
  return config;
}

// ── Exclusion helpers ────────────────────────────────────────────────────────

/**
 * Build a parameterized slug exclusion clause.
 * Returns { clause, params } where clause is e.g. "AND slug NOT IN ($3, $4, $5)"
 */
function getSlugExclusions(paramOffset: number): { clause: string; params: string[] } {
  const values = config.core_rules.slug_exclusions.values || [];
  if (values.length === 0) return { clause: "", params: [] };
  const placeholders = values.map((_, i) => `$${paramOffset + i}`).join(", ");
  return {
    clause: `AND slug NOT IN (${placeholders})`,
    params: values,
  };
}

/** Build a parameterized DnB source exclusion clause (for leads only). */
function getDnBExclusion(paramOffset: number): { clause: string; params: string[] } {
  return {
    clause: `AND development_opportunities.source != $${paramOffset}`,
    params: ["DnB"],
  };
}

/** Location ILIKE filter for a given table/column */
function getLocationCondition(locations?: string[], tablePrefix: string = "development_opportunities", column: string = "interested_location"): string {
  if (!locations || locations.length === 0) return "";
  const conditions = locations.map(loc => `${tablePrefix}.${column} ILIKE '%${loc}%'`);
  return `AND (${conditions.join(" OR ")})`;
}

// ── Stage type builders ──────────────────────────────────────────────────────

/**
 * Build SQL for a multi_source stage (e.g. Leads = opportunities UNION enquiries).
 * Reads source_1_opportunities + source_2_enquiries from the stage config.
 */
function buildMultiSourceQuery(stage: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const slugExcl = getSlugExclusions(3);
  const dnbExcl = getDnBExclusion(3 + slugExcl.params.length);

  // Source 1: development_opportunities
  const src1 = stage.source_1_opportunities!;
  const oppsLocationCondition = getLocationCondition(locations, src1.table, "interested_location");

  const oppsSql = `
    SELECT ${src1.count_expression} AS leads
    FROM ${src1.table}
    WHERE (date(${src1.timestamp_column} + interval '330 minutes') BETWEEN $1 AND $2)
    ${oppsLocationCondition}
    ${slugExcl.clause}
    ${dnbExcl.clause}
  `;

  // Source 2: enquiries
  const src2 = stage.source_2_enquiries!;
  const enqLocationCondition = getLocationCondition(locations, src2.table, "location");
  const enqConditions = (src2.mandatory_conditions || []).map(c => `AND ${c}`).join("\n    ");

  const enqSql = `
    SELECT ${src2.count_expression} AS leads
    FROM ${src2.table}
    WHERE (date(${src2.table}.${src2.timestamp_column} + interval '5 hours 30 minutes') BETWEEN $1 AND $2)
    ${enqConditions}
    ${enqLocationCondition}
  `;

  const sql = `
          -- ${stage.metric_name}
          SELECT '${stage.metric_name}' as metric, SUM(leads)::int as count
          FROM
          (
            ${oppsSql}
            UNION ALL
            ${enqSql}
          ) leads_data
  `;

  return { sql, params: [...slugExcl.params, ...dnbExcl.params] };
}

/**
 * Build SQL for a single_source stage (e.g. Prospects, Accounts, Sales).
 * Reads table, timestamp_column, mandatory_conditions from stage config.
 */
function buildSingleSourceQuery(stage: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const table = stage.table || "development_opportunities";
  const timestampCol = stage.timestamp_column!;

  const slugExcl = getSlugExclusions(3);
  const conditions = (stage.mandatory_conditions || []).map(c => `AND ${c}`).join("\n            ");
  const locationCondition = getLocationCondition(locations, table, "interested_location");

  // development_opportunities has no vertical column — gate on isprava only
  const verticalCondition = table === "development_opportunities"
    ? `AND '${vertical}' = 'isprava'`
    : `AND vertical = '${vertical}'`;

  const sql = `
          -- ${stage.metric_name}
          SELECT '${stage.metric_name}' as metric, ${stage.count_expression}::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${verticalCondition}
            ${slugExcl.clause}
            ${conditions}
            ${locationCondition}
  `;

  return { sql, params: slugExcl.params };
}

/**
 * Build SQL for a join_source stage (e.g. Meetings, Viewings).
 * Reads tables[], join_conditions[], timestamp_column, timestamp_table from config.
 */
function buildJoinSourceQuery(stage: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const tables = stage.tables || [];
  const joins = stage.join_conditions || [];
  const timestampCol = stage.timestamp_column!;
  const timestampTable = stage.timestamp_table || tables[0];

  const slugExcl = stage.mandatory_exclusions.includes("slug_exclusions")
    ? getSlugExclusions(3)
    : { clause: "", params: [] as string[] };

  const conditions = (stage.mandatory_conditions || []).map(c => `AND ${c}`).join("\n            ");
  const locationCondition = getLocationCondition(locations, "development_opportunities", "interested_location");

  // Build FROM + JOINs: first table is the base, rest are INNER JOINs
  const [baseTable, ...joinTables] = tables;
  const joinClauses = joinTables.map(t => {
    const matchingCondition = joins.find(j => j.includes(t));
    return matchingCondition ? `INNER JOIN ${t} ON ${matchingCondition}` : `INNER JOIN ${t}`;
  }).join("\n          ");

  const sql = `
          -- ${stage.metric_name}
          SELECT '${stage.metric_name}' as metric, ${stage.count_expression}::int as count
          FROM ${baseTable}
          ${joinClauses}
          WHERE ${timestampTable}.${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampTable}.${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${slugExcl.clause}
            ${conditions}
            ${locationCondition}
  `;

  return { sql, params: slugExcl.params };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a query for a single metric by its config key.
 * Dispatches to the correct builder based on stage.type.
 */
export function buildMetricQuery(stageKey: string, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const stage = config.funnel_stages[stageKey];
  if (!stage) {
    throw new Error(`Unknown funnel metric: ${stageKey}`);
  }

  switch (stage.type) {
    case "multi_source":
      return buildMultiSourceQuery(stage, vertical, locations);
    case "single_source":
      return buildSingleSourceQuery(stage, vertical, locations);
    case "join_source":
      return buildJoinSourceQuery(stage, vertical, locations);
    default:
      throw new Error(`Unknown stage type "${stage.type}" for metric "${stageKey}"`);
  }
}

/**
 * Build the combined funnel query.
 * If metricKey is provided, returns only that metric.
 * If omitted, returns all metrics UNIONed and ordered by sort_order.
 */
export function buildSalesFunnelQuery(vertical: Vertical, locations?: string[], metricKey?: string): ParameterizedQuery {
  // Single metric mode
  if (metricKey) {
    return buildMetricQuery(metricKey, vertical, locations);
  }

  // All metrics mode — sort by sort_order, UNION ALL
  const stages = Object.entries(config.funnel_stages)
    .sort(([, a], [, b]) => a.sort_order - b.sort_order);

  const metricQueries = stages.map(([key]) => buildMetricQuery(key, vertical, locations));

  const unionSql = metricQueries.map(q => q.sql).join("\n          UNION ALL\n");

  // Build ORDER BY from sort_order
  const orderCases = stages
    .map(([, stage]) => `WHEN metric = '${stage.metric_name}' THEN ${stage.sort_order}`)
    .join("\n          ");

  const sql = `
        SELECT * FROM
        (
          ${unionSql}
        ) query
        ORDER BY CASE
          ${orderCases}
          ELSE 999
        END
  `;

  // Collect the superset of all params. The multi_source (leads) query has the
  // most params (slugs + DnB), others are a subset. Since all sub-queries share
  // the same $N numbering starting at $3, we use the longest params array.
  const supersetParams = metricQueries.reduce<unknown[]>(
    (longest, q) => q.params.length > longest.length ? q.params : longest,
    []
  );

  return { sql, params: supersetParams };
}
