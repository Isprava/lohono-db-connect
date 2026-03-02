import { buildMetricQuery, ParameterizedQuery } from "./sales-funnel-builder.js";
import { Vertical } from "../../shared/types/verticals.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ILIKE location filter against a chapter_opportunities column. */
function chapterLocationCondition(
    locations?: string[],
    table: string = "chapter_opportunities",
    column: string = "interested_location",
): string {
    if (!locations || locations.length === 0) return "";
    const conditions = locations.map(
        (loc) => `${table}.${column} ILIKE '%${loc}%'`,
    );
    return `AND (${conditions.join(" OR ")})`;
}

/** Standard test-record exclusion for chapter_opportunities rows. */
function chapterTestExclusion(alias: string = "chapter_opportunities"): string {
    return `AND (lower(${alias}.name) NOT LIKE '%test%'
          AND lower(${alias}.name) NOT LIKE 'test%'
          AND lower(${alias}.name) != 'test')`;
}

// ── Re-use existing Chapter queries (Leads / Prospects / Accounts / Sales) ────
// The existing buildMetricQuery already routes to `chapter_opportunities` when
// vertical === Vertical.THE_CHAPTER — we simply wrap those calls here so this
// file is the single source of truth for all Chapter funnel queries.

/**
 * Leads for The Chapter.
 * Custom implementation that mirrors the reference SQL exactly:
 *   - Excludes DnB source (source != 'DnB') from chapter_opportunities
 *   - Excludes test records by name
 *   - Unions chapter_opportunities + enquiries (vertical='chapter')
 *
 * NOTE: DnB is excluded as a SQL literal (not a $N param) to avoid numbering
 * conflicts with the slug-exclusion params used by the other sub-queries in the
 * combined buildChapterFunnelQuery.
 */
export function buildChapterLeads(locations?: string[]): ParameterizedQuery {
    const oppsLocationCond = chapterLocationCondition(locations, "chapter_opportunities", "interested_location");
    const enqLocationCond = chapterLocationCondition(locations, "enquiries", "location");
    const testExclOpps = chapterTestExclusion("chapter_opportunities");
    const testExclEnq = chapterTestExclusion("enquiries");

    const oppsSql = `
        SELECT COUNT(DISTINCT(chapter_opportunities.slug)) AS leads
        FROM chapter_opportunities
        WHERE date(enquired_at + interval '330 minutes') BETWEEN $1 AND $2
          AND chapter_opportunities.source != 'DnB'
          ${testExclOpps}
          ${oppsLocationCond}
    `;

    const enqSql = `
        SELECT COUNT(id) AS leads
        FROM enquiries
        WHERE date(enquiries.created_at + interval '5 hours 30 minutes') BETWEEN $1 AND $2
          AND enquiries.vertical = 'chapter'
          AND enquiry_type = 'enquiry'
          AND leadable_id IS NULL
          ${testExclEnq}
          ${enqLocationCond}
    `;

    const sql = `
          -- Leads (Chapter)
          SELECT 'Leads' as metric, SUM(leads)::int as count
          FROM (
            ${oppsSql}
            UNION ALL
            ${enqSql}
          ) leads_data
    `;

    return { sql, params: [] };
}

/** Prospects for The Chapter — delegates to the existing single_source query builder. */
export function buildChapterProspects(locations?: string[]): ParameterizedQuery {
    return buildMetricQuery("prospect", Vertical.THE_CHAPTER, locations);
}

/** Accounts for The Chapter — delegates to the existing single_source query builder. */
export function buildChapterAccounts(locations?: string[]): ParameterizedQuery {
    return buildMetricQuery("account", Vertical.THE_CHAPTER, locations);
}

/** Sales for The Chapter — delegates to the existing single_source query builder. */
export function buildChapterSales(locations?: string[]): ParameterizedQuery {
    return buildMetricQuery("sale", Vertical.THE_CHAPTER, locations);
}

// ── New Chapter-specific queries ──────────────────────────────────────────────

/**
 * Viewings for The Chapter.
 * Counts distinct chapter_opportunities slugs that had a viewing-type task
 * performed within the date range (IST-corrected).
 * Uses 'Chapter::Opportunity' as the polymorphic leadable_type.
 * No regional (source_region) filter — that is Isprava-south-only.
 */
export function buildChapterViewings(locations?: string[]): ParameterizedQuery {
    const locationCond = chapterLocationCondition(locations);
    const testExcl = chapterTestExclusion();

    const sql = `
          -- Viewings (Chapter)
          SELECT 'Viewings' as metric,
                 COUNT(DISTINCT(chapter_opportunities.slug))::int as count
          FROM tasks
          INNER JOIN activities
            ON tasks.id = activities.feedable_id
          INNER JOIN medium
            ON tasks.medium_id = medium.id
          INNER JOIN chapter_opportunities
            ON chapter_opportunities.id = activities.leadable_id
          INNER JOIN staffs
            ON staffs.id = chapter_opportunities.poc_exec_id
          WHERE date(tasks.performed_at + interval '330 minutes') BETWEEN $1 AND $2
            AND activities.feedable_type = 'Task'
            AND activities.leadable_type = 'Chapter::Opportunity'
            AND medium.name IN (
              'Goa Viewing',
              'Alibaug Viewing',
              'Coonoor Viewing',
              'Viewing',
              'Site Visit'
            )
            ${testExcl}
            ${locationCond}
  `;

    return { sql, params: [] };
}

/**
 * Meetings for The Chapter.
 * Counts distinct chapter_opportunities slugs that had a Meeting-type task
 * performed within the date range (IST-corrected).
 * Uses 'Chapter::Opportunity' as the polymorphic leadable_type.
 */
export function buildChapterMeetings(locations?: string[]): ParameterizedQuery {
    const locationCond = chapterLocationCondition(locations);
    const testExcl = chapterTestExclusion();

    const sql = `
          -- Meetings (Chapter)
          SELECT 'Meetings' as metric,
                 COUNT(DISTINCT(chapter_opportunities.slug))::int as count
          FROM tasks
          INNER JOIN activities
            ON tasks.id = activities.feedable_id
          INNER JOIN medium
            ON tasks.medium_id = medium.id
          INNER JOIN chapter_opportunities
            ON chapter_opportunities.id = activities.leadable_id
          WHERE date(tasks.performed_at + interval '330 minutes') BETWEEN $1 AND $2
            AND activities.feedable_type = 'Task'
            AND activities.leadable_type = 'Chapter::Opportunity'
            AND medium.name = 'Meeting'
            ${testExcl}
            ${locationCond}
  `;

    return { sql, params: [] };
}

/**
 * L2P (Lead-to-Prospect) duration for The Chapter.
 * Average number of days between enquired_at and lead_completed_at,
 * filtered by lead_completed_at falling within the requested date range (IST).
 * Metric label is "L2P" (business shorthand sometimes written "12P").
 */
export function buildChapterL2P(locations?: string[]): ParameterizedQuery {
    const locationCond = chapterLocationCondition(locations);
    const testExcl = chapterTestExclusion();

    const sql = `
          -- 12P (Lead to Prospect duration, Chapter)
          SELECT '12P' as metric,
                 AVG(
                   date(lead_completed_at + interval '330 minutes')
                   - date(enquired_at      + interval '330 minutes')
                 )::int as count
          FROM chapter_opportunities
          WHERE date(lead_completed_at + interval '330 minutes') BETWEEN $1 AND $2
            AND enquired_at IS NOT NULL
            AND lead_completed_at IS NOT NULL
            ${testExcl}
            ${locationCond}
  `;

    return { sql, params: [] };
}

/**
 * P2A (Prospect-to-Account) duration for The Chapter.
 * Average number of days between lead_completed_at and prospect_completed_at,
 * filtered by prospect_completed_at falling within the requested date range (IST).
 */
export function buildChapterP2A(locations?: string[]): ParameterizedQuery {
    const locationCond = chapterLocationCondition(locations);
    const testExcl = chapterTestExclusion();

    const sql = `
          -- P2A (Prospect to Account duration, Chapter)
          SELECT 'P2A' as metric,
                 AVG(
                   date(prospect_completed_at + interval '330 minutes')
                   - date(lead_completed_at   + interval '330 minutes')
                 )::int as count
          FROM chapter_opportunities
          WHERE date(prospect_completed_at + interval '330 minutes') BETWEEN $1 AND $2
            AND lead_completed_at IS NOT NULL
            AND prospect_completed_at IS NOT NULL
            ${testExcl}
            ${locationCond}
  `;

    return { sql, params: [] };
}

/**
 * A2S (Account-to-Sale) duration for The Chapter.
 * Average number of days between prospect_completed_at and maal_laao_at,
 * filtered by maal_laao_at falling within the requested date range (IST).
 */
export function buildChapterA2S(locations?: string[]): ParameterizedQuery {
    const locationCond = chapterLocationCondition(locations);
    const testExcl = chapterTestExclusion();

    const sql = `
          -- A2S (Account to Sale duration, Chapter)
          SELECT 'A2S' as metric,
                 AVG(
                   date(maal_laao_at           + interval '330 minutes')
                   - date(prospect_completed_at + interval '330 minutes')
                 )::int as count
          FROM chapter_opportunities
          WHERE date(maal_laao_at + interval '330 minutes') BETWEEN $1 AND $2
            AND prospect_completed_at IS NOT NULL
            AND maal_laao_at IS NOT NULL
            ${testExcl}
            ${locationCond}
  `;

    return { sql, params: [] };
}

// ── Public dispatcher ─────────────────────────────────────────────────────────

/**
 * Metric keys supported by this file, in display sort order.
 * The 4 legacy keys (lead / prospect / account / sale) delegate to the
 * existing sales-funnel-builder; the 5 new ones are implemented above.
 */
export const CHAPTER_METRIC_KEYS = [
    "viewing",
    "meeting",
    "l2p",
    "p2a",
    "a2s",
    "lead",
    "prospect",
    "account",
    "sale",
] as const;

export type ChapterMetricKey = (typeof CHAPTER_METRIC_KEYS)[number];

/** Metadata for each Chapter metric (used for sort order and display). */
export const CHAPTER_METRIC_META: Record<
    ChapterMetricKey,
    { metricName: string; sortOrder: number }
> = {
    viewing: { metricName: "Viewings", sortOrder: 1 },
    meeting: { metricName: "Meetings", sortOrder: 2 },
    l2p: { metricName: "12P", sortOrder: 3 },
    p2a: { metricName: "P2A", sortOrder: 4 },
    a2s: { metricName: "A2S", sortOrder: 5 },
    lead: { metricName: "Leads", sortOrder: 6 },
    prospect: { metricName: "Prospects", sortOrder: 7 },
    account: { metricName: "Accounts", sortOrder: 8 },
    sale: { metricName: "Sales", sortOrder: 9 },
};

/**
 * Build a query for a single Chapter metric by its key.
 * Throws for unknown keys.
 */
export function buildChapterMetricQuery(
    key: string,
    locations?: string[],
): ParameterizedQuery {
    switch (key) {
        case "viewing": return buildChapterViewings(locations);
        case "meeting": return buildChapterMeetings(locations);
        case "l2p": return buildChapterL2P(locations);
        case "p2a": return buildChapterP2A(locations);
        case "a2s": return buildChapterA2S(locations);
        case "lead": return buildChapterLeads(locations);
        case "prospect": return buildChapterProspects(locations);
        case "account": return buildChapterAccounts(locations);
        case "sale": return buildChapterSales(locations);
        default:
            throw new Error(`Unknown Chapter funnel metric: "${key}"`);
    }
}

/**
 * Build the combined Chapter funnel query.
 * If metricKey is provided, returns only that metric.
 * If omitted, returns all 9 Chapter metrics UNIONed and ordered by sort_order.
 *
 * NOTE: Single-source sub-queries (prospect/account/sale) still include slug
 * exclusion params ($3/$4/$5) even for Chapter. We collect the superset of all
 * sub-query params so every $N placeholder has a matching bind value.
 */
export function buildChapterFunnelQuery(
    locations?: string[],
    metricKey?: string,
): ParameterizedQuery {
    // Single metric mode
    if (metricKey) {
        return buildChapterMetricQuery(metricKey, locations);
    }

    // Full funnel mode — UNION ALL all metrics in sort order
    const allQueries = CHAPTER_METRIC_KEYS.map((key) =>
        buildChapterMetricQuery(key, locations),
    );

    const metricSql = allQueries
        .map((q) => q.sql)
        .join("\n          UNION ALL\n");

    const orderCases = CHAPTER_METRIC_KEYS.map(
        (key) =>
            `WHEN metric = '${CHAPTER_METRIC_META[key].metricName}' THEN ${CHAPTER_METRIC_META[key].sortOrder}`,
    ).join("\n          ");

    const sql = `
        SELECT * FROM
        (
          ${metricSql}
        ) chapter_funnel_data
        ORDER BY CASE
          ${orderCases}
          ELSE 999
        END
  `;

    // Use the longest params array (superset) so all $N placeholders are covered
    const supersetParams = allQueries.reduce<unknown[]>(
        (longest, q) => (q.params.length > longest.length ? q.params : longest),
        [],
    );

    return { sql, params: supersetParams };
}
