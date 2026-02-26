import { ParameterizedQuery } from "./sales-funnel-builder.js";
import { locationCond } from "./consolidated-scorecard-builder.js";

// ── Indian FY start helper ────────────────────────────────────────────────────
// Refund subqueries filter from Apr 1 of the current Indian FY.
function currentFYStart(): string {
    const istMs = 5.5 * 60 * 60 * 1000;
    const now = new Date(Date.now() + istMs);
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1; // 1-12
    const fyStartYear = m >= 4 ? y : y - 1;
    return `${fyStartYear}-04-01`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Builds the Ageing Analysis (Consolidated Dashboard) SQL for Isprava + Chapter.
 * This is a current-state snapshot query — no date range needed beyond the
 * current Indian FY start for refund sub-queries.
 *
 * Columns returned:
 *   property, step, ageing_bucket, amount_in_cr, brand, sort_key
 */
export function buildAgeingAnalysisQuery(
    locations?: string[],
): ParameterizedQuery {
    const fyStart = currentFYStart();
    const loc = locationCond(locations, "o");

    const sql = `
-- ==================== AGEING ANALYSIS: ISPRAVA + CHAPTER ====================

WITH

isprava_base_data AS (
    SELECT
        a.slug,
        a.name,
        a.sub_phase,
        a.step,
        a.property,
        a.location,
        a.delivery_timeline_id,
        a.payment_due_date,
        a.delivery_tracker_status,
        a.is_subsidiary,
        a.is_construction_linked,
        a.payment_date,
        a.ops_actual_date,
        a.client_communication_date,
        COALESCE(a.base_amount, 0) AS base_amount,
        COALESCE(b.base_amount_paid, 0) AS base_amount_paid,
        COALESCE(a.base_amount, 0) - COALESCE(b.base_amount_paid, 0) + COALESCE(c.refund_amount, 0) AS pending_amount
    FROM (
        SELECT
            'https://oi.lohono.com/development/opportunities/' || o.slug AS slug,
            o.name,
            p.name AS property,
            ph.sub_phase,
            phd.step,
            l.city AS location,
            dt.id AS delivery_timeline_id,
            dt.payment_due_date,
            dt.status AS delivery_tracker_status,
            phd.is_construction_linked,
            dt.payment_date,
            dt.ops_actual_date,
            dt.client_communication_date,
            SUM(CASE WHEN phd.step = 'Excess collection'
                     THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                     ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS base_amount,
            development_bank_accounts.is_subsidiary
        FROM development_opportunity_properties op
        INNER JOIN development_properties p ON op.development_property_id = p.id
        INNER JOIN development_locations l ON l.id = p.development_location_id
        INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
        INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
        LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
        INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
        LEFT  JOIN development_opportunity_property_bank_accounts opba
               ON opba.development_opportunity_property_id = op.id
              AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
              AND opba.account_type = 'base'
        LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
        WHERE p.include_in_reports = TRUE
          AND p.deleted_at IS NULL
          AND dt.deleted_at IS NULL
          AND development_bank_accounts.is_subsidiary = TRUE
          AND backed_out_at IS NULL
          AND ${loc}
        GROUP BY o.slug, o.name, p.name, l.city, dt.id, dt.payment_due_date, dt.status,
                 phd.is_construction_linked, dt.payment_date, ops_actual_date,
                 client_communication_date, development_bank_accounts.is_subsidiary, sub_phase, step
    ) a
    LEFT JOIN (
        SELECT dt.id AS delivery_timeline_id,
               SUM(CASE WHEN t.transaction_type = 'collection'
                        THEN (t.breakdown->>'base_amount')::FLOAT ELSE 0 END) AS base_amount_paid
        FROM development_opportunity_properties op
        INNER JOIN development_properties p ON op.development_property_id = p.id
        INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
        INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
        LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
        WHERE p.active = TRUE AND dt.deleted_at IS NULL AND t.deleted_at IS NULL
        GROUP BY dt.id
    ) b ON a.delivery_timeline_id = b.delivery_timeline_id
    LEFT JOIN (
        SELECT p.id, p.name, SUM((t.breakdown->>'base_amount')::float) AS refund_amount, dt.id AS delivery_timeline_id
        FROM development_opportunity_properties op
        INNER JOIN development_properties p ON op.development_property_id = p.id
        INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
        INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
        LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
        LEFT  JOIN development_bank_accounts ON development_bank_accounts.id =
                  CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
        WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
          AND t.deleted_at IS NULL AND p.active = TRUE
          AND t.transaction_type = 'refund'
          AND t.payment_date BETWEEN '${fyStart}' AND DATE(now() + INTERVAL '330 minutes')
          AND ${loc}
        GROUP BY p.name, dt.id, p.id
    ) c ON a.delivery_timeline_id = c.delivery_timeline_id
),

isprava_filtered AS (
    SELECT * FROM isprava_base_data
    WHERE is_subsidiary = TRUE
      AND NOT (is_construction_linked = TRUE AND ops_actual_date IS NULL)
      AND client_communication_date <= CURRENT_DATE
),

isprava_ageing AS (
    SELECT f.*,
           (CURRENT_DATE - f.payment_due_date) AS days_overdue,
           CASE
               WHEN (CURRENT_DATE - f.client_communication_date) <= 30  THEN 'Within Timelines'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 60  THEN '0 - 30 Days'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 90  THEN '31 - 60 Days'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 120 THEN '61 - 90 Days'
               ELSE '90+ Days'
           END AS ageing_bucket
    FROM isprava_filtered f
),

isprava_payment_dates AS (
    SELECT dt.id AS delivery_timeline_id,
           MIN(CASE WHEN t.transaction_type = 'collection' AND t.deleted_at IS NULL THEN t.payment_date END) AS payment_date_for_advance
    FROM development_delivery_timelines dt
    LEFT JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
    WHERE dt.deleted_at IS NULL
    GROUP BY dt.id
),

isprava_advances AS (
    SELECT bd.property, bd.sub_phase, bd.step, bd.delivery_tracker_status,
           bd.client_communication_date, bd.base_amount_paid, pd.payment_date_for_advance, bd.delivery_timeline_id
    FROM isprava_base_data bd
    LEFT JOIN isprava_payment_dates pd ON bd.delivery_timeline_id = pd.delivery_timeline_id
    WHERE bd.base_amount_paid > 0
      AND bd.client_communication_date > CURRENT_DATE
      AND pd.payment_date_for_advance IS NOT NULL
      AND (bd.client_communication_date IS NULL OR pd.payment_date_for_advance < bd.client_communication_date)
      AND bd.delivery_tracker_status IN ('upcoming', 'not_due')
),

isprava_additional_advances AS (
    SELECT bd.property, bd.sub_phase, bd.step, bd.delivery_tracker_status,
           bd.client_communication_date, bd.base_amount_paid, pd.payment_date_for_advance, bd.delivery_timeline_id
    FROM isprava_base_data bd
    LEFT JOIN isprava_payment_dates pd ON bd.delivery_timeline_id = pd.delivery_timeline_id
    WHERE bd.is_subsidiary = TRUE
      AND bd.sub_phase = 'additional'
      AND bd.base_amount_paid > 0
      AND bd.client_communication_date > CURRENT_DATE
      AND pd.payment_date_for_advance < bd.client_communication_date
      AND NOT EXISTS (SELECT 1 FROM isprava_advances ia WHERE ia.delivery_timeline_id = bd.delivery_timeline_id)
),

isprava_ageing_agg AS (
    SELECT property, step, ageing_bucket,
           ROUND(SUM(pending_amount)::numeric, 2) AS amount_in_cr
    FROM isprava_ageing
    GROUP BY property, step, ageing_bucket
),

isprava_advances_agg AS (
    SELECT property, step, 'Advance'::text AS ageing_bucket,
           ROUND((SUM(base_amount_paid)::numeric * -1), 2) AS amount_in_cr
    FROM (SELECT * FROM isprava_advances UNION ALL SELECT * FROM isprava_additional_advances) x
    GROUP BY property, step
),

/* ==================== CHAPTER ==================== */

chapter_base_data AS (
    SELECT
        a.slug, a.name, a.sub_phase, a.step, a.property, a.location,
        a.delivery_timeline_id, a.payment_due_date, a.delivery_tracker_status,
        a.is_subsidiary, a.is_construction_linked, a.payment_date,
        a.ops_actual_date, a.client_communication_date,
        COALESCE(a.base_amount, 0) AS base_amount,
        COALESCE(b.base_amount_paid, 0) AS base_amount_paid,
        COALESCE(a.base_amount, 0) - COALESCE(b.base_amount_paid, 0) + COALESCE(c.refund_amount, 0) AS pending_amount
    FROM (
        SELECT
            'https://oi.lohono.com/chapter/opportunities/' || o.slug AS slug,
            o.name,
            p.name AS property,
            ph.sub_phase,
            phd.step,
            l.city AS location,
            dt.id AS delivery_timeline_id,
            dt.payment_due_date,
            dt.status AS delivery_tracker_status,
            phd.is_construction_linked,
            dt.payment_date,
            dt.ops_actual_date,
            dt.client_communication_date,
            SUM(CASE WHEN phd.step = 'Excess collection'
                     THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                     ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS base_amount,
            chapter_bank_accounts.is_subsidiary
        FROM chapter_opportunity_properties op
        INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
        INNER JOIN chapter_locations l ON l.id = p.chapter_location_id
        INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
        INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
        LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
        INNER JOIN chapter_delivery_timeline_phases ph ON dt.chapter_delivery_timeline_phase_id = ph.id
        LEFT  JOIN chapter_opportunity_property_bank_accounts opba
               ON opba.chapter_opportunity_property_id = op.id
              AND opba.chapter_delivery_timeline_phase_id = dt.chapter_delivery_timeline_phase_id
              AND opba.account_type = 'base'
        LEFT  JOIN chapter_bank_accounts ON opba.chapter_bank_account_id = chapter_bank_accounts.id
        WHERE p.include_in_reports = TRUE
          AND p.deleted_at IS NULL
          AND dt.deleted_at IS NULL
          AND p.name != 'Chapter Test Property'
          AND ${loc}
        GROUP BY o.slug, o.name, p.name, l.city, dt.id, dt.payment_due_date, dt.status,
                 phd.is_construction_linked, dt.payment_date, ops_actual_date,
                 client_communication_date, chapter_bank_accounts.is_subsidiary, sub_phase, step
    ) a
    LEFT JOIN (
        SELECT dt.id AS delivery_timeline_id,
               SUM(CASE WHEN t.transaction_type = 'collection'
                        THEN (t.breakdown->>'base_amount')::FLOAT ELSE 0 END) AS base_amount_paid
        FROM chapter_opportunity_properties op
        INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
        INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
        INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
        LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
        WHERE p.active = TRUE AND dt.deleted_at IS NULL AND t.deleted_at IS NULL
        GROUP BY dt.id
    ) b ON a.delivery_timeline_id = b.delivery_timeline_id
    LEFT JOIN (
        SELECT p.id, p.name, SUM((t.breakdown->>'base_amount')::float) AS refund_amount, dt.id AS delivery_timeline_id
        FROM chapter_opportunity_properties op
        INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
        INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
        INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
        LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
        LEFT  JOIN chapter_bank_accounts ON chapter_bank_accounts.id =
                  CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
        WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
          AND t.deleted_at IS NULL AND p.active = TRUE
          AND t.transaction_type = 'refund'
          AND t.payment_date BETWEEN '${fyStart}' AND DATE(now() + INTERVAL '330 minutes')
          AND ${loc}
        GROUP BY p.name, dt.id, p.id
    ) c ON a.delivery_timeline_id = c.delivery_timeline_id
),

chapter_filtered AS (
    SELECT * FROM chapter_base_data
    WHERE client_communication_date <= CURRENT_DATE
),

chapter_ageing AS (
    SELECT f.*,
           (CURRENT_DATE - f.payment_due_date) AS days_overdue,
           CASE
               WHEN (CURRENT_DATE - f.client_communication_date) <= 30  THEN 'Within Timelines'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 60  THEN '0 - 30 Days'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 90  THEN '31 - 60 Days'
               WHEN (CURRENT_DATE - f.client_communication_date) <= 120 THEN '61 - 90 Days'
               ELSE '90+ Days'
           END AS ageing_bucket
    FROM chapter_filtered f
),

chapter_payment_dates AS (
    SELECT dt.id AS delivery_timeline_id,
           MIN(CASE WHEN t.transaction_type = 'collection' AND t.deleted_at IS NULL THEN t.payment_date END) AS payment_date_for_advance
    FROM chapter_delivery_timelines dt
    LEFT JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
    WHERE dt.deleted_at IS NULL
    GROUP BY dt.id
),

chapter_advances AS (
    SELECT bd.property, bd.sub_phase, bd.step, bd.delivery_tracker_status,
           bd.client_communication_date, bd.base_amount_paid, pd.payment_date_for_advance, bd.delivery_timeline_id
    FROM chapter_base_data bd
    LEFT JOIN chapter_payment_dates pd ON bd.delivery_timeline_id = pd.delivery_timeline_id
    WHERE bd.base_amount_paid > 0
      AND bd.client_communication_date > CURRENT_DATE
      AND pd.payment_date_for_advance IS NOT NULL
      AND (bd.client_communication_date IS NULL OR pd.payment_date_for_advance < bd.client_communication_date)
      AND bd.delivery_tracker_status IN ('upcoming', 'not_due')
),

chapter_additional_advances AS (
    SELECT bd.property, bd.sub_phase, bd.step, bd.delivery_tracker_status,
           bd.client_communication_date, bd.base_amount_paid, pd.payment_date_for_advance, bd.delivery_timeline_id
    FROM chapter_base_data bd
    LEFT JOIN chapter_payment_dates pd ON bd.delivery_timeline_id = pd.delivery_timeline_id
    WHERE bd.sub_phase = 'additional'
      AND bd.base_amount_paid > 0
      AND bd.client_communication_date > CURRENT_DATE
      AND pd.payment_date_for_advance < bd.client_communication_date
      AND NOT EXISTS (SELECT 1 FROM chapter_advances ia WHERE ia.delivery_timeline_id = bd.delivery_timeline_id)
),

chapter_ageing_agg AS (
    SELECT property, step, ageing_bucket,
           ROUND(SUM(pending_amount)::numeric, 2) AS amount_in_cr
    FROM chapter_ageing
    GROUP BY property, step, ageing_bucket
),

chapter_advances_agg AS (
    SELECT property, step, 'Advance'::text AS ageing_bucket,
           ROUND((SUM(base_amount_paid)::numeric * -1), 2) AS amount_in_cr
    FROM (SELECT * FROM chapter_advances UNION ALL SELECT * FROM chapter_additional_advances) x
    GROUP BY property, step
)

/* ==================== FINAL UNION ==================== */
SELECT property, step, ageing_bucket, amount_in_cr,
       'Isprava' AS brand,
       CASE ageing_bucket
           WHEN 'Within Timelines' THEN 1
           WHEN '0 - 30 Days'      THEN 2
           WHEN '31 - 60 Days'     THEN 3
           WHEN '61 - 90 Days'     THEN 4
           WHEN '90+ Days'         THEN 5
           WHEN 'Advance'          THEN 6
           ELSE 7
       END AS sort_key
FROM isprava_ageing_agg

UNION ALL

SELECT property, step, 'Advance' AS ageing_bucket, amount_in_cr,
       'Isprava' AS brand, 6 AS sort_key
FROM isprava_advances_agg

UNION ALL

SELECT property, step, ageing_bucket, amount_in_cr,
       'Chapter' AS brand,
       CASE ageing_bucket
           WHEN 'Within Timelines' THEN 1
           WHEN '0 - 30 Days'      THEN 2
           WHEN '31 - 60 Days'     THEN 3
           WHEN '61 - 90 Days'     THEN 4
           WHEN '90+ Days'         THEN 5
           WHEN 'Advance'          THEN 6
           ELSE 7
       END AS sort_key
FROM chapter_ageing_agg

UNION ALL

SELECT property, step, 'Advance' AS ageing_bucket, amount_in_cr,
       'Chapter' AS brand, 6 AS sort_key
FROM chapter_advances_agg

ORDER BY sort_key, brand, property, step, amount_in_cr DESC;
`;

    return { sql, params: [] };
}
