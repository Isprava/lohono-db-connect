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

// Build location condition - simpler ILIKE pattern matching user's query
if (vertical == Vertical.THE_CHAPTER) {
  return buildChapterLeadsQuery(locations);
} else {
  let oppsLocationCondition = "";
  let enqLocationCondition = "";

  if (locations && locations.length > 0) {
    // For development_opportunities, search interested_location
    const oppsLocConditions = locations.map(loc => `development_opportunities.interested_location ILIKE '%${loc}%'`).join(" OR ");
    oppsLocationCondition = `AND (${oppsLocConditions})`;

    // For enquiries, search locationgit config pull.rebase false 
    const enqLocConditions = locations.map(loc => `location ILIKE '%${loc}%'`).join(" OR ");
    enqLocationCondition = `AND (${enqLocConditions})`;
  }

  // 1. Opportunities Part - matching user's query format
  const oppsSql = `
    SELECT COUNT(DISTINCT(development_opportunities.slug)) AS leads
    FROM development_opportunities
    WHERE (date(enquired_at + interval '330 minutes') BETWEEN $1 AND $2)
    ${oppsLocationCondition}
    ${slugExcl.clause}
    ${dnbExcl.clause}
  `;

  // 2. Enquiries Part - matching user's query format
  const enqSql = `
    SELECT COUNT(id) AS leads
    FROM enquiries
    WHERE enquiries.vertical = 'development'
    AND enquiry_type = 'enquiry'
    AND leadable_id IS NULL
    ${enqLocationCondition}
  `;

  const finalQuery = `
          -- Leads
          SELECT 'Leads' as metric, SUM(leads)::int as count
          FROM
          (
            ${oppsSql}
            UNION ALL
            ${enqSql}
          ) leads_data
  `;
  console.log('[DEBUG] vertical', vertical);
  console.log('[DEBUG] buildLeadsQuery SQL:', finalQuery);
  console.log('[DEBUG] oppsLocation condition:', oppsLocationCondition);
  console.log('[DEBUG] enqLocation condition:', enqLocationCondition);

  return finalQuery;
}
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

export function buildProspectsQuery(vertical: Vertical, locations?: string[]): string {
  if (vertical === Vertical.THE_CHAPTER) {
    return buildChapterProspectsQuery(locations);
  }
  return buildStageQuerySimple("Prospects", config.funnel_stages.prospect, vertical, locations);
}

export function buildAccountsQuery(vertical: Vertical, locations?: string[]): string {
  if (vertical === Vertical.THE_CHAPTER) {
    return buildChapterAccountsQuery(locations);
  }
  return buildStageQuerySimple("Accounts", config.funnel_stages.account, vertical, locations);
}

export function buildSalesQuery(vertical: Vertical, locations?: string[]): string {
  if (vertical === Vertical.THE_CHAPTER) {
    return buildChapterSalesQuery(locations);
  }
  return buildStageQuerySimple("Sales", config.funnel_stages.sale, vertical, locations);
}

export function buildSalesFunnelQuery(vertical: Vertical, locations?: string[]): string {
  // Build individual queries
  const leadsVal = buildLeadsQuery(vertical, locations);
  // Wrap in subquery to get single row with 'Leads' metric
  // Prospects
  const prospectsVal = buildProspectsQuery(vertical, locations);
  // Accounts
  const accountsVal = buildAccountsQuery(vertical, locations);
  // Sales
  const salesVal = buildSalesQuery(vertical, locations);

  return `
        SELECT metric, count
        FROM
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

// ============================================================================
// CHAPTER VERTICAL QUERIES
// ============================================================================

// Helper for Chapter name-based test exclusions
function getChapterNameExclusions(tablePrefix: string = "chapter_opportunities"): string {
  return `AND (lower(${tablePrefix}.name) NOT LIKE '%test%' 
       AND lower(${tablePrefix}.name) NOT LIKE 'test%' 
       AND lower(${tablePrefix}.name) != 'test')`;
}

// Helper for Chapter location filtering
function getChapterLocationCondition(locations?: string[], tablePrefix: string = "chapter_opportunities", column: string = "interested_location"): string {
  if (!locations || locations.length === 0) return "";

  const conditions: string[] = [];
  for (const loc of locations) {
    conditions.push(`${tablePrefix}.${column} ILIKE '%${loc}%'`);
  }

  return `AND (${conditions.join(" OR ")})`;
}

/**
 * Build Chapter Leads query using LEFT JOIN pattern
 * Combines chapter_opportunities + enquiries (vertical='chapter')
 * Matches reference Redash query format exactly.
 */
export function buildChapterLeadsQuery(locations?: string[]): string {
  const oppsLocationCondition = getChapterLocationCondition(locations, "chapter_opportunities", "interested_location");
  const enqLocationCondition = getChapterLocationCondition(locations, "enquiries", "location");
  const nameExclusionOpps = getChapterNameExclusions("chapter_opportunities");
  const nameExclusionEnq = getChapterNameExclusions("enquiries");

  // Part A: Chapter Opportunities — exact reference query format
  const oppsSql = `
    SELECT 'Leads' as metric,
           COUNT(DISTINCT(chapter_opportunities.slug)) as leads
    FROM chapter_opportunities
    WHERE date(enquired_at + interval '330 minutes') BETWEEN $1 AND $2
    ${nameExclusionOpps}
    ${oppsLocationCondition}
  `;

  // Part B: Chapter Enquiries — exact reference query format
  const enqSql = `
    SELECT 'Leads' as metric,
           COUNT(id) as leads2
    FROM enquiries
    WHERE enquiries.vertical = 'chapter'
    AND enquiry_type = 'enquiry'
    AND leadable_id IS NULL
    AND date(enquiries.created_at + interval '330 minutes') BETWEEN $1 AND $2
    ${nameExclusionEnq}
    ${enqLocationCondition}
  `;

  // LEFT JOIN pattern (Chapter-specific) — exact reference query format
  const finalQuery = `
    SELECT
      a.metric,
      (COALESCE(a.leads, 0) + COALESCE(b.leads2, 0)) as count
    FROM (${oppsSql}) a
    LEFT JOIN (${enqSql}) b ON a.metric = b.metric
  `;

  console.log('[DEBUG] buildChapterLeadsQuery SQL:', finalQuery);
  console.log('[DEBUG] Chapter oppsLocation condition:', oppsLocationCondition);
  console.log('[DEBUG] Chapter enqLocation condition:', enqLocationCondition);

  return finalQuery;
}

function buildChapterStageQuerySimple(stageName: string, timestampCol: string, locations?: string[]): string {
  const table = "chapter_opportunities";
  const nameExclusion = getChapterNameExclusions(table);
  const locationCondition = getChapterLocationCondition(locations, table, "interested_location");

  // Mandatory condition: timestamp must be present
  const mandatoryCondition = `AND ${timestampCol} IS NOT NULL`;

  return `
    SELECT '${stageName}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
    FROM ${table}
    WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
      AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
      ${mandatoryCondition}
      ${nameExclusion}
      ${locationCondition}
  `;
}

export function buildChapterProspectsQuery(locations?: string[]): string {
  // Reference query logic for Location:
  // If user provides locations, build partial match OR group.
  // If no location, use ILIKE '%%' to match non-nulls (consistent with Redash template).
  const locationCondition = (locations && locations.length > 0)
    ? getChapterLocationCondition(locations, "chapter_opportunities", "interested_location")
    : `AND chapter_opportunities.interested_location ILIKE '%%'`;

  const nameExclusion = getChapterNameExclusions("chapter_opportunities");

  // Matches user's requested format:
  // SELECT 'Prospects' as metric, count(distinct(chapter_opportunities.slug)) as prospects
  // ... WHERE date(lead_completed_at ...) ...
  const sql = `
    SELECT 'Prospects' as metric, 
           COUNT(DISTINCT(chapter_opportunities.slug)) as prospects 
    FROM chapter_opportunities 
    WHERE date(lead_completed_at + interval '330 minutes') BETWEEN $1 AND $2
    ${nameExclusion}
    ${locationCondition}
  `;

  console.log('[DEBUG] buildChapterProspectsQuery SQLnameExclusion:', nameExclusion);
  console.log('[DEBUG] buildChapterProspectsQuery SQLlocationCondition:', locationCondition);

  return sql;
}

export function buildChapterAccountsQuery(locations?: string[]): string {
  // Reference query logic for Location:
  const locationCondition = (locations && locations.length > 0)
    ? getChapterLocationCondition(locations, "chapter_opportunities", "interested_location")
    : `AND chapter_opportunities.interested_location ILIKE '%%'`;

  const nameExclusion = getChapterNameExclusions("chapter_opportunities");

  // Matches user's requested format:
  // SELECT 'Accounts' as metric, count(distinct(chapter_opportunities.slug)) as accounts
  // ... WHERE date(prospect_completed_at ...) ...
  const sql = `
    SELECT 'Accounts' as metric,
           COUNT(DISTINCT(chapter_opportunities.slug)) as accounts
    FROM chapter_opportunities
    WHERE date(prospect_completed_at + interval '330 minutes') BETWEEN $1 AND $2
    ${nameExclusion}
    ${locationCondition}
  `;

  console.log('[DEBUG] buildChapterAccountsQuery SQLnameExclusion:', nameExclusion);
  console.log('[DEBUG] buildChapterAccountsQuery SQLlocationCondition:', locationCondition);

  return sql;
}

export function buildChapterSalesQuery(locations?: string[]): string {
  // Reference query logic for Location:
  const locationCondition = (locations && locations.length > 0)
    ? getChapterLocationCondition(locations, "chapter_opportunities", "interested_location")
    : `AND chapter_opportunities.interested_location ILIKE '%%'`;

  const nameExclusion = getChapterNameExclusions("chapter_opportunities");

  // Matches user's requested format:
  // SELECT 'Sales' as metric, count(distinct(chapter_opportunities.slug)) as sales
  // ... WHERE date(maal_laao_at ...) ...
  const sql = `
     SELECT 'Sales' as metric,
            COUNT(DISTINCT(chapter_opportunities.slug)) as sales
     FROM chapter_opportunities
     WHERE date(maal_laao_at + interval '330 minutes') BETWEEN $1 AND $2
     ${nameExclusion}
     ${locationCondition}
  `;

  console.log('[DEBUG] buildChapterSalesQuery SQLnameExclusion:', nameExclusion);
  console.log('[DEBUG] buildChapterSalesQuery SQLlocationCondition:', locationCondition);

  return sql;
}