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

/** Map a vertical to its primary opportunities table name. */
function getOpportunitiesTable(vertical: Vertical): string {
  switch (vertical) {
    case Vertical.THE_CHAPTER: return "chapter_opportunities";
    default: return "development_opportunities";
  }
}

/** Build a parameterized DnB source exclusion clause (for leads only). */
function getDnBExclusion(paramOffset: number, table: string = "development_opportunities"): { clause: string; params: string[] } {
  return {
    clause: `AND ${table}.source != $${paramOffset}`,
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
 * For non-Isprava verticals only source_1 is used (enquiries filters on vertical='development').
 */
function buildMultiSourceQuery(stage: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const oppsTable = getOpportunitiesTable(vertical);
  const isIsprava = vertical === Vertical.ISPRAVA;
  const isChapter = vertical === Vertical.THE_CHAPTER;

  // Slug and DnB exclusions are Isprava-only
  const slugExcl = isIsprava ? getSlugExclusions(3) : { clause: "", params: [] as string[] };
  const dnbExcl = isIsprava ? getDnBExclusion(3 + slugExcl.params.length, oppsTable) : { clause: "", params: [] as string[] };

  // Test name exclusions are Chapter-only
  const testNameExclOpps = isChapter
    ? `AND (lower(${oppsTable}.name) NOT LIKE '%test%' AND lower(${oppsTable}.name) NOT LIKE 'test%' AND lower(${oppsTable}.name) != 'test')`
    : "";
  const testNameExclEnq = isChapter
    ? `AND (lower(enquiries.name) NOT LIKE '%test%' AND lower(enquiries.name) NOT LIKE 'test%' AND lower(enquiries.name) != 'test')`
    : "";

  // Source 1: vertical-specific opportunities table
  const src1 = stage.source_1_opportunities!;
  const oppsLocationCondition = getLocationCondition(locations, oppsTable, "interested_location");

  const oppsSql = `
    SELECT COUNT(DISTINCT(${oppsTable}.slug)) AS leads
    FROM ${oppsTable}
    WHERE (date(${src1.timestamp_column} + interval '330 minutes') BETWEEN $1 AND $2)
    ${oppsLocationCondition}
    ${slugExcl.clause}
    ${dnbExcl.clause}
    ${testNameExclOpps}
  `;

  // Source 2: enquiries — Isprava uses vertical='development', Chapter uses vertical='chapter'
  const src2 = stage.source_2_enquiries!;
  const enqLocationCondition = getLocationCondition(locations, src2.table, "location");
  const enqVertical = isChapter ? "chapter" : "development";

  const enqSql = `
    SELECT ${src2.count_expression} AS leads
    FROM ${src2.table}
    WHERE (date(${src2.table}.${src2.timestamp_column} + interval '5 hours 30 minutes') BETWEEN $1 AND $2)
    AND ${src2.table}.vertical = '${enqVertical}'
    AND enquiry_type = 'enquiry'
    AND leadable_id IS NULL
    ${testNameExclEnq}
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
 * Routes to the vertical-specific opportunities table — no extra vertical column
 * filter needed since each table contains only that vertical's data.
 */
function buildSingleSourceQuery(stage: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const table = getOpportunitiesTable(vertical);
  const timestampCol = stage.timestamp_column!;

  const slugExcl = getSlugExclusions(3);
  const conditions = (stage.mandatory_conditions || []).map(c => `AND ${c}`).join("\n            ");
  const locationCondition = getLocationCondition(locations, table, "interested_location");

  const sql = `
          -- ${stage.metric_name}
          SELECT '${stage.metric_name}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
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

/**
 * Build SQL for an orderbook_source stage (Outlook / Orderbook Actuals).
 * Aggregates development_opportunity_properties joined with properties, locations,
 * and opportunities — filtered by maal_laao_at date range (IST) with fixed exclusions.
 * Returns total booked value in Crore (rounded to int) as the matrix count.
 */
function buildOrderbookSourceQuery(stage: FunnelStage, _vertical: Vertical, locations?: string[]): ParameterizedQuery {
  // Location filter on o.interested_location (ILIKE, OR-combined)
  const locationFilter = locations && locations.length > 0
    ? `AND (${locations.map(loc => `o.interested_location ILIKE '%${loc}%'`).join(" OR ")})`
    : "";

  const sql = `
          -- ${stage.metric_name}
          SELECT '${stage.metric_name}' as metric, COALESCE(SUM(amount_cr), 0)::int as count
          FROM (
            SELECT
              SUM((op.budget_sales_consideration)::float) / 10000000 as amount_cr
            FROM development_opportunity_properties op
            LEFT JOIN development_properties p  ON op.development_property_id  = p.id
            LEFT JOIN development_locations   l  ON l.id                        = p.development_location_id
            LEFT JOIN development_opportunities o ON op.development_opportunity_id = o.id
            WHERE p.include_in_reports = TRUE
              AND p.deleted_at IS NULL
              AND (
                DATE(o.maal_laao_at + INTERVAL '330 minutes') BETWEEN $1 AND $2
                OR o.slug = 'd-ref-a2ff7f98'
                OR o.slug = '7A5D8F55'
              )
              AND p.name != 'Dattapada Estate 2'
              ${locationFilter}
            GROUP BY l.city, p.property_type
          ) orderbook_data
  `;

  return { sql, params: [] };
}

/**
 * Build the detailed orderbook breakdown query for Isprava.
 * Returns one row per (city, property_type) with amount_cr and units_sold.
 */
function buildIspravaOrderbookDetailQuery(locations?: string[]): ParameterizedQuery {
  const locationFilter = locations && locations.length > 0
    ? `AND (${locations.map(loc => `o.interested_location ILIKE '%${loc}%'`).join(" OR ")})`
    : "";

  const sql = `
    SELECT
      l.city AS location,
      p.property_type,
      ROUND(SUM((p.budget_sales_consideration)::float / 10000000)::numeric, 2) AS amount_cr,
      COUNT(op.id) AS units_sold
    FROM development_opportunity_properties op
    LEFT JOIN development_properties p ON op.development_property_id = p.id
    LEFT JOIN development_locations l ON l.id = p.development_location_id
    LEFT JOIN development_opportunities o ON op.development_opportunity_id = o.id
    WHERE p.include_in_reports = TRUE
      AND p.deleted_at IS NULL
      AND (
        DATE(o.maal_laao_at + INTERVAL '330 minutes') BETWEEN $1 AND $2
        OR o.slug = 'd-ref-a2ff7f98'
        OR o.slug = '7A5D8F55'
      )
      AND p.name != 'Dattapada Estate 2'
      ${locationFilter}
    GROUP BY l.city, p.property_type
    ORDER BY l.city, p.property_type
  `;

  return { sql, params: [] };
}

/**
 * Build the detailed orderbook breakdown query for The Chapter.
 * Returns one row per city with property_type fixed as 'Chapter', amount_cr and units_sold.
 */
function buildChapterOrderbookDetailQuery(locations?: string[]): ParameterizedQuery {
  const locationFilter = locations && locations.length > 0
    ? `AND (${locations.map(loc => `o.interested_location ILIKE '%${loc}%'`).join(" OR ")})`
    : "";

  const sql = `
    SELECT
      COALESCE(l.city, 'Unclassified') AS location,
      'Chapter' AS property_type,
      ROUND(SUM((p.budget_sales_consideration)::float / 10000000)::numeric, 2) AS amount_cr,
      COUNT(op.id)::int AS units_sold
    FROM chapter_opportunity_properties op
    LEFT JOIN chapter_properties p ON op.chapter_property_id = p.id
    LEFT JOIN chapter_locations l ON l.id = p.chapter_location_id
    LEFT JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    WHERE p.include_in_reports = TRUE
      AND p.deleted_at IS NULL
      AND (
        DATE(o.maal_laao_at + INTERVAL '330 minutes') BETWEEN $1 AND $2
        OR o.slug = 'd-ref-a2ff7f98'
      )
      AND p.name != 'Dattapada Estate 2'
      ${locationFilter}
    GROUP BY l.city
    ORDER BY location
  `;

  return { sql, params: [] };
}

/**
 * Build the detailed orderbook breakdown query.
 * Routes to the vertical-specific implementation.
 * Returns one row per (location, property_type) with amount_cr and units_sold.
 */
export function buildOrderbookDetailQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  if (vertical === Vertical.THE_CHAPTER) {
    return buildChapterOrderbookDetailQuery(locations);
  }
  return buildIspravaOrderbookDetailQuery(locations);
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
    case "orderbook_source":
      return buildOrderbookSourceQuery(stage, vertical, locations);
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
