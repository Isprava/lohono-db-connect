import { loadSalesFunnelConfig } from "./config-loader.js";
import { SalesFunnelConfig, FunnelStage } from "./sales-funnel-types.js";

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

// Helper query for Leads (Opportunities + Enquiries)
export function buildLeadsQuery(): ParameterizedQuery {
  const stage = config.funnel_stages.lead;

  // Params: $1 = start_date, $2 = end_date, then slug exclusions, then DnB
  const slugExcl = getSlugExclusions(3);
  const dnbExcl = getDnBExclusion(3 + slugExcl.params.length);

  // 1. Opportunities Part
  const oppsConfig = stage.source_1_opportunities!;
  const oppsTimestamp = oppsConfig.timestamp_column;

  const oppsSql = `
    SELECT COUNT(DISTINCT(development_opportunities.slug)) AS leads
    FROM ${oppsConfig.table}
    WHERE ${oppsTimestamp} >= ($1::date - INTERVAL '330 minutes')
      AND ${oppsTimestamp} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
      ${slugExcl.clause}
      ${dnbExcl.clause}
      AND status != 'trash'
  `;

  // 2. Enquiries Part
  const enqConfig = stage.source_2_enquiries!;
  const enqTimestamp = enqConfig.timestamp_column;
  const enqConditions = enqConfig.mandatory_conditions.map(c => `AND ${c}`).join("\n      ");

  const enqSql = `
    SELECT COUNT(id) AS leads
    FROM ${enqConfig.table}
    WHERE ${enqTimestamp} >= ($1::date - INTERVAL '330 minutes')
      AND ${enqTimestamp} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
      ${enqConditions}
  `;

  return {
    sql: `
          -- Leads
          SELECT 'Leads' as metric, SUM(leads)::int as count
          FROM
          (
            ${oppsSql}
            UNION ALL
            ${enqSql}
          ) leads_data
    `,
    params: [...slugExcl.params, ...dnbExcl.params],
  };
}

// Generic builder for simple stages (Prospect, Account, Sale)
function buildStageQuerySimple(stageName: string, stageConfig: FunnelStage): ParameterizedQuery {
  const table = stageConfig.table || "development_opportunities";
  const timestampCol = stageConfig.timestamp_column!;

  // Params: $1 = start_date, $2 = end_date, then slug exclusions starting at $3
  const slugExcl = getSlugExclusions(3);

  const conditions = (stageConfig.mandatory_conditions || []).map(c => `AND ${c}`).join("\n      ");

  return {
    sql: `
          -- ${stageName}
          SELECT '${stageName}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${slugExcl.clause}
            ${conditions}
    `,
    params: slugExcl.params,
  };
}

export function buildProspectsQuery(): ParameterizedQuery {
  return buildStageQuerySimple("Prospects", config.funnel_stages.prospect);
}

export function buildAccountsQuery(): ParameterizedQuery {
  return buildStageQuerySimple("Accounts", config.funnel_stages.account);
}

export function buildSalesQuery(): ParameterizedQuery {
  return buildStageQuerySimple("Sales", config.funnel_stages.sale);
}

export function buildSalesFunnelQuery(): ParameterizedQuery {
  const leads = buildLeadsQuery();
  const prospects = buildProspectsQuery();
  const accounts = buildAccountsQuery();
  const sales = buildSalesQuery();

  // All sub-queries share the same param slots:
  // $1 = start_date, $2 = end_date, $3..$N = slug exclusions, $N+1 = DnB value
  // Leads has the most params (slugs + DnB), others only have slugs.
  // Since UNION ALL shares param namespace, we use the leads params (superset).
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

  return { sql, params: leads.params };
}
