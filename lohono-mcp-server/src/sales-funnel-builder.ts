import { loadSalesFunnelConfig } from "./config-loader.js";
import { SalesFunnelConfig, FunnelStage } from "./sales-funnel-types.js";

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

// Helper query for Leads (Opportunities + Enquiries)
export function buildLeadsQuery(): string {
  const stage = config.funnel_stages.lead;
  const slugExclusion = getSlugExclusions();
  const dnbExclusion = getDnBExclusion();

  // 1. Opportunities Part
  const oppsConfig = stage.source_1_opportunities!;
  // "enquired_at"
  const oppsTimestamp = oppsConfig.timestamp_column;

  const oppsSql = `
    SELECT COUNT(DISTINCT(development_opportunities.slug)) AS leads
    FROM ${oppsConfig.table}
    WHERE ${oppsTimestamp} >= ($1::date - INTERVAL '330 minutes')
      AND ${oppsTimestamp} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
      ${slugExclusion}
      ${dnbExclusion}
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

  return `
          -- Leads
          SELECT 'Leads' as metric, SUM(leads)::int as count
          FROM
          (
            ${oppsSql}
            UNION ALL
            ${enqSql}
          ) leads_data
  `;
}

// Generic builder for simple stages (Prospect, Account, Sale)
function buildStageQuerySimple(stageName: string, stageConfig: FunnelStage): string {
  const table = stageConfig.table || "development_opportunities";
  const timestampCol = stageConfig.timestamp_column!;
  const slugExclusion = getSlugExclusions();

  // Checking mandatory conditions (e.g. "lead_completed_at IS NOT NULL")
  const conditions = (stageConfig.mandatory_conditions || []).map(c => `AND ${c}`).join("\n      ");

  return `
          -- ${stageName}
          SELECT '${stageName}' as metric, COUNT(DISTINCT(${table}.slug))::int as count
          FROM ${table}
          WHERE ${timestampCol} >= ($1::date - INTERVAL '330 minutes')
            AND ${timestampCol} < ($2::date + INTERVAL '1 day' - INTERVAL '330 minutes')
            ${slugExclusion}
            ${conditions}
  `;
}

export function buildProspectsQuery(): string {
  return buildStageQuerySimple("Prospects", config.funnel_stages.prospect);
}

export function buildAccountsQuery(): string {
  return buildStageQuerySimple("Accounts", config.funnel_stages.account);
}

export function buildSalesQuery(): string {
  return buildStageQuerySimple("Sales", config.funnel_stages.sale);
}

export function buildSalesFunnelQuery(): string {
  // Leads
  const leadsVal = buildLeadsQuery();

  // Prospects
  const prospectsVal = buildProspectsQuery();

  // Accounts
  const accountsVal = buildAccountsQuery();

  // Sales
  const salesVal = buildSalesQuery();

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
