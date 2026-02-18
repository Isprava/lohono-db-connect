import { loadSalesFunnelConfig } from "./config-loader.js";
import { SalesFunnelConfig, FunnelStage } from "./sales-funnel-types.js";
import { Vertical } from "../../shared/types/verticals.js";

const config: SalesFunnelConfig = loadSalesFunnelConfig();

function getSlugExclusions(): string {
  const values = config.core_rules.slug_exclusions.values || [];
  if (values.length === 0) return "";
  const formattedValues = values.map((v) => `'${v}'`).join(", ");
  return `AND slug NOT IN (${formattedValues})`;
}

// Helper to get DnB exclusion (for leads only)
function getDnBExclusion(): string {
  // core_rules.source_exclusion_dnb
  // "sql_pattern": "development_opportunities.source != 'DnB'"
  return `AND development_opportunities.source != 'DnB'`;
}

// Helper query for location filtering
function getLocationCondition(locations?: string[], tablePrefix: string = "development_opportunities", column: string = "interested_location"): string {
  if (!locations || locations.length === 0) return "";

  // Generate OR conditions for location matching
  // Only search the specified column (interested_location) to avoid false matches
  // e.g., avoid matching "Mumbai" in source_city when interested_location is "Goa"
  const conditions: string[] = [];

  for (const loc of locations) {
    conditions.push(`${tablePrefix}.${column} ILIKE '%${loc}%'`);
  }

  return `AND (${conditions.join(" OR ")})`;
}

// Helper query for Leads (Opportunities + Enquiries)
export function buildLeadsQuery(vertical: Vertical, locations?: string[]): string {
  const stage = config.funnel_stages.lead;
  const slugExclusion = getSlugExclusions();

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

      // For enquiries, search location
      const enqLocConditions = locations.map(loc => `location ILIKE '%${loc}%'`).join(" OR ");
      enqLocationCondition = `AND (${enqLocConditions})`;
    }

    // 1. Opportunities Part - matching user's query format
    const oppsSql = `
    SELECT COUNT(DISTINCT(development_opportunities.slug)) AS leads
    FROM development_opportunities
    WHERE (date(enquired_at + interval '330 minutes') BETWEEN $1 AND $2)
    ${oppsLocationCondition}
    ${slugExclusion}
  `;

    // 2. Enquiries Part - matching user's query format
    const enqSql = `
    SELECT COUNT(id) AS leads
    FROM enquiries
    WHERE enquiries.vertical = 'development'
    AND enquiry_type = 'enquiry'
    AND leadable_id IS NULL
    ${enqLocationCondition}
    AND (date(enquiries.created_at + interval '5 hours 30 minutes') BETWEEN $1 AND $2)
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

// Generic builder for simple stages (Prospect, Account, Sale)
function buildStageQuerySimple(stageName: string, stageConfig: FunnelStage, vertical: Vertical, locations?: string[]): string {
  const table = stageConfig.table || "development_opportunities";
  const timestampCol = stageConfig.timestamp_column!;
  const slugExclusion = getSlugExclusions();

  // Checking mandatory conditions (e.g. "lead_completed_at IS NOT NULL")
  const conditions = (stageConfig.mandatory_conditions || []).map(c => `AND ${c}`).join("\n      ");

  const locationCondition = getLocationCondition(locations, table, "interested_location");  // Only search interested_location

  // Fix for development_opportunities having no vertical column
  const verticalCondition = table === 'development_opportunities'
    ? `AND '${vertical}' = 'isprava'`
    : `AND vertical = '${vertical}'`;

  return `
          -- ${stageName}
          SELECT '${stageName}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${verticalCondition}
            ${slugExclusion}
            ${conditions}
            ${locationCondition}
  `;
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
          ${leadsVal}
          UNION ALL
          ${prospectsVal}
          UNION ALL
          ${accountsVal}
          UNION ALL
          ${salesVal}
        ) query
        ORDER BY CASE
          WHEN metric = 'Leads' THEN 1
          WHEN metric = 'Prospects' THEN 2
          WHEN metric = 'Accounts' THEN 3
          WHEN metric = 'Sales' THEN 4
          ELSE 5
        END
  `;
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