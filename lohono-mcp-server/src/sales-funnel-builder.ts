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

  console.log('[DEBUG] buildLeadsQuery SQL:', finalQuery);
  console.log('[DEBUG] oppsLocation condition:', oppsLocationCondition);
  console.log('[DEBUG] enqLocation condition:', enqLocationCondition);

  return finalQuery;
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
  return buildStageQuerySimple("Prospects", config.funnel_stages.prospect, vertical, locations);
}

export function buildAccountsQuery(vertical: Vertical, locations?: string[]): string {
  return buildStageQuerySimple("Accounts", config.funnel_stages.account, vertical, locations);
}

export function buildSalesQuery(vertical: Vertical, locations?: string[]): string {
  return buildStageQuerySimple("Sales", config.funnel_stages.sale, vertical, locations);
}

export function buildSalesFunnelQuery(vertical: Vertical, locations?: string[]): string {
  // Leads
  const leadsVal = buildLeadsQuery(vertical, locations);

  // Prospects
  const prospectsVal = buildProspectsQuery(vertical, locations);

  // Accounts
  const accountsVal = buildAccountsQuery(vertical, locations);

  // Sales
  const salesVal = buildSalesQuery(vertical, locations);

  return `
        SELECT * FROM
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
