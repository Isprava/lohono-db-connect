import { loadSalesFunnelConfig } from "./config-loader.js";
import { SalesFunnelConfig, FunnelStage } from "./sales-funnel-types.js";
import { Vertical } from "../../shared/types/verticals.js";

const config: SalesFunnelConfig = loadSalesFunnelConfig();

/** Result from a query builder — SQL with parameterized placeholders and matching values */
export interface ParameterizedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build a parameterized slug exclusion clause.
 * Returns { clause, params } where clause is e.g. "AND slug NOT IN ($3, $4, $5)"
 * and params are the slug values.
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

/**
 * Build a parameterized DnB source exclusion clause (for leads only).
 */
function getDnBExclusion(paramOffset: number): { clause: string; params: string[] } {
  return {
    clause: `AND development_opportunities.source != $${paramOffset}`,
    params: ["DnB"],
  };
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
export function buildLeadsQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const stage = config.funnel_stages.lead;

  // Params: $1 = start_date, $2 = end_date, then slug exclusions based on offset 3
  const slugExcl = getSlugExclusions(3);
  // source exclusion comes after slug exclusions
  const dnbExcl = getDnBExclusion(3 + slugExcl.params.length);

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
    ${slugExcl.clause}
    ${dnbExcl.clause}
  `;

  // 2. Enquiries Part - matching user's query format
  // Note: Enquiries might not support slug exclusion or DnB exclusion same way, 
  // but typically enquiries are cleaner. 
  // However, earlier code only applied slug/dnb to Opps. 

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

  return {
    sql: finalQuery,
    params: [...slugExcl.params, ...dnbExcl.params]
  };
}

// Generic builder for simple stages (Prospect, Account, Sale)
function buildStageQuerySimple(stageName: string, stageConfig: FunnelStage, vertical: Vertical, locations?: string[]): ParameterizedQuery {
  const table = stageConfig.table || "development_opportunities";
  const timestampCol = stageConfig.timestamp_column!;

  // Params: $1 = start_date, $2 = end_date, then slug exclusions starting at $3
  const slugExcl = getSlugExclusions(3);

  const conditions = (stageConfig.mandatory_conditions || []).map(c => `AND ${c}`).join("\n      ");

  const locationCondition = getLocationCondition(locations, table, "interested_location");  // Only search interested_location

  // Fix for development_opportunities having no vertical column
  const verticalCondition = table === 'development_opportunities'
    ? `AND '${vertical}' = 'isprava'`
    : `AND vertical = '${vertical}'`;

  const sql = `
          -- ${stageName}
          SELECT '${stageName}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${verticalCondition}
            ${slugExcl.clause}
            ${conditions}
            ${locationCondition}
  `;

  return {
    sql,
    params: slugExcl.params
  };
}

export function buildProspectsQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  return buildStageQuerySimple("Prospects", config.funnel_stages.prospect, vertical, locations);
}

export function buildAccountsQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  return buildStageQuerySimple("Accounts", config.funnel_stages.account, vertical, locations);
}

export function buildSalesQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  return buildStageQuerySimple("Sales", config.funnel_stages.sale, vertical, locations);
}

export function buildSalesFunnelQuery(vertical: Vertical, locations?: string[]): ParameterizedQuery {
  // Leads
  const leads = buildLeadsQuery(vertical, locations);

  // Prospects
  const prospects = buildProspectsQuery(vertical, locations);

  // Accounts
  const accounts = buildAccountsQuery(vertical, locations);

  // Sales
  const sales = buildSalesQuery(vertical, locations);

  const sql = `
        SELECT * FROM
        (
          ${leads.sql}
          UNION ALL
          ${prospects.sql}
          UNION ALL
          ${accounts.sql}
          UNION ALL
          ${sales.sql}
        ) query
        ORDER BY CASE
          WHEN metric = 'Leads' THEN 1
          WHEN metric = 'Prospects' THEN 2
          WHEN metric = 'Accounts' THEN 3
          WHEN metric = 'Sales' THEN 4
          ELSE 5
        END
  `;

  // Leads has the superset of params (slugs + DnB). 
  // Other queries only use slugs (subset of leads params).
  // IMPORTANT: The order of params in the array must match the $N placeholders.
  // Leads params: [...slugs, 'DnB'] -> $3..$N, $N+1
  // Prospects params: [...slugs] -> $3..$N. It does NOT use $N+1.
  // When we execute this combined query, we pass [start, end, ...slugs, 'DnB'].
  // So $N+1 will be available for Leads part, and ignored by others.

  return { sql, params: leads.params };
}

