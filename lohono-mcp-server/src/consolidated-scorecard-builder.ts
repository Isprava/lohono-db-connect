import { ParameterizedQuery } from "./sales-funnel-builder.js";

// ── Location filter helper ────────────────────────────────────────────────────

/** Build an ILIKE location condition. Exported for reuse in other builders. */
export function locationCond(
  locations: string[] | undefined,
  alias: string,
  col = "interested_location",
): string {
  if (!locations || locations.length === 0) return "1=1";
  return `(${locations.map((l) => `${alias}.${col} ILIKE '%${l}%'`).join(" OR ")})`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Builds the Consolidated Scorecard SQL for both Isprava and Chapter verticals.
 * Accepts explicit start/end dates so any date range can be queried.
 * All date filter literals are server-computed from caller params; no raw user
 * input is interpolated (callers must validate dates before passing).
 * Location filtering is optional via ILIKE.
 */
export function buildConsolidatedScorecardQuery(
  startDate: string,
  endDate: string,
  locations?: string[],
): ParameterizedQuery {
  const s = startDate;  // short alias for readability inside template strings
  const e = endDate;
  const loc = locationCond(locations, "o");

  const sql = `
-- ==================== CONSOLIDATED SCORECARD: ISPRAVA + CHAPTER ====================

WITH isprava_base_data AS (
    SELECT p.name AS property
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    WHERE p.include_in_reports = TRUE
      AND backed_out_at IS NULL
      AND ${loc}
),

-- ── LYTD BUDGET: Construction-Linked ─────────────────────────────────────────
lytd_construction AS (
    SELECT p.name AS property,
           SUM((dt.breakdown->>'base_amount')::float) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND phd.is_construction_linked = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.ops_actual_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── LYTD BUDGET: Construction-Linked Revised ──────────────────────────────────
lytd_construction_revised AS (
    SELECT p.name AS property,
           SUM((dt.breakdown->>'base_amount')::float) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND phd.is_construction_linked = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.ops_actual_date IS NOT NULL
      AND CASE
            WHEN dt.client_communication_date > dt.ops_actual_date
            THEN dt.client_communication_date ELSE dt.ops_actual_date
          END BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── LYTD BUDGET: Payment-Linked ───────────────────────────────────────────────
lytd_payment AS (
    SELECT p.name AS property,
           SUM(CASE WHEN phd.step = 'Excess collection'
                    THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.client_communication_date BETWEEN '${s}' AND '${e}'
      AND CASE WHEN ph.sub_phase = 'additional' AND development_bank_accounts.is_subsidiary = TRUE
               THEN FALSE ELSE phd.is_construction_linked END = FALSE
      AND ${loc}
    GROUP BY p.name
),

-- ── LYTD ACTUALS: Collected ───────────────────────────────────────────────────
lytd_collected AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS collected_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    LEFT  JOIN development_bank_accounts ON development_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── LYTD ACTUALS: Refunds ─────────────────────────────────────────────────────
lytd_refunds AS (
    SELECT p.name AS property,
           SUM(CASE WHEN t.transaction_type = 'refund'
                    THEN (-1) * COALESCE((t.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((t.breakdown->>'base_amount')::float, 0) END) AS refund_amount
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
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── YTD BUDGET: Construction-Linked ──────────────────────────────────────────
ytd_construction AS (
    SELECT p.name AS property,
           SUM((dt.breakdown->>'base_amount')::float) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND phd.is_construction_linked = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.ops_actual_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

ytd_construction_revised AS (
    SELECT p.name AS property,
           SUM((dt.breakdown->>'base_amount')::float) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND phd.is_construction_linked = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.ops_actual_date IS NOT NULL
      AND CASE WHEN dt.client_communication_date > dt.ops_actual_date
               THEN dt.client_communication_date ELSE dt.ops_actual_date
          END BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── YTD BUDGET: Payment-Linked ────────────────────────────────────────────────
ytd_payment AS (
    SELECT p.name AS property,
           SUM(CASE WHEN phd.step = 'Excess collection'
                    THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS budget_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND development_bank_accounts.is_subsidiary = TRUE
      AND dt.client_communication_date BETWEEN '${s}' AND '${e}'
      AND CASE WHEN ph.sub_phase = 'additional' AND development_bank_accounts.is_subsidiary = TRUE
               THEN FALSE ELSE phd.is_construction_linked END = FALSE
      AND ${loc}
    GROUP BY p.name
),

-- ── YTD ACTUALS: Collected ────────────────────────────────────────────────────
ytd_collected AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS collected_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    LEFT  JOIN development_bank_accounts ON development_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── YTD ACTUALS: Refunds ──────────────────────────────────────────────────────
ytd_refunds AS (
    SELECT p.name AS property,
           SUM(CASE WHEN t.transaction_type = 'refund'
                    THEN (-1) * COALESCE((t.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((t.breakdown->>'base_amount')::float, 0) END) AS refund_amount
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
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

-- ── Advances: Future Budget with Early Payments ───────────────────────────────
future_budget_early_payment AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS early_payment_amount
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN development_bank_accounts ON development_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND development_bank_accounts.is_subsidiary = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date < COALESCE(
            CASE WHEN phd.is_construction_linked = TRUE THEN
                   CASE WHEN dt.client_communication_date IS NOT NULL AND (dt.ops_actual_date IS NULL OR dt.client_communication_date > dt.ops_actual_date)
                        THEN dt.client_communication_date ELSE dt.ops_actual_date END
                 WHEN phd.is_construction_linked = FALSE THEN dt.client_communication_date
                 WHEN CASE WHEN ph.sub_phase = 'additional' AND development_bank_accounts.is_subsidiary = TRUE
                           THEN FALSE ELSE phd.is_construction_linked END = FALSE
                      THEN dt.client_communication_date
                 ELSE dt.ops_actual_date END,
            dt.ops_actual_date, dt.client_communication_date)
      AND COALESCE(
            CASE WHEN phd.is_construction_linked = TRUE THEN
                   CASE WHEN dt.client_communication_date IS NOT NULL AND (dt.ops_actual_date IS NULL OR dt.client_communication_date > dt.ops_actual_date)
                        THEN dt.client_communication_date ELSE dt.ops_actual_date END
                 WHEN phd.is_construction_linked = FALSE THEN dt.client_communication_date
                 WHEN CASE WHEN ph.sub_phase = 'additional' AND development_bank_accounts.is_subsidiary = TRUE
                           THEN FALSE ELSE phd.is_construction_linked END = FALSE
                      THEN dt.client_communication_date
                 ELSE dt.ops_actual_date END,
            dt.ops_actual_date, dt.client_communication_date) > CURRENT_DATE
      AND ${loc}
    GROUP BY p.name
),

-- ── Isprava Milestone Actual Pending ─────────────────────────────────────────
milestone_base_data AS (
    SELECT o.slug, o.name, dt.id AS delivery_timeline_id, l.city AS location,
           DATE(o.maal_laao_at + INTERVAL '330 minutes') AS sales_date,
           p.name AS property, phd.step AS stage_name,
           SUM((dt.breakdown->>'base_amount')::float) AS base_amount,
           SUM((dt.breakdown->>'gst_amount')::float) AS gst_amount,
           SUM((dt.breakdown->>'stamp_duty_amount')::float) AS stamp_duty_amount,
           SUM((dt.breakdown->>'registration_amount')::float) AS registration_amount,
           SUM((dt.breakdown->>'tds_amount')::float) AS tds_amount,
           SUM(dt.total_amount) AS total_amount,
           dt.id AS did, ops_budget_date, ops_actual_date, client_communication_date,
           payment_due_date, phd.id AS phdid, sub_phase,
           is_construction_linked, is_subsidiary, dt.status AS delivery_tracker_status
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_locations l ON l.id = p.development_location_id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_phase_details phd ON dt.development_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN development_delivery_timeline_phases ph ON dt.development_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN development_opportunity_property_bank_accounts opba
           ON opba.development_opportunity_property_id = op.id
          AND opba.development_delivery_timeline_phase_id = dt.development_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN development_bank_accounts ON opba.development_bank_account_id = development_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND development_bank_accounts.is_subsidiary = TRUE
      AND ${loc}
      AND (
            (phd.is_construction_linked = TRUE
             AND DATE(CASE WHEN client_communication_date IS NOT NULL AND ops_actual_date IS NOT NULL
                               AND client_communication_date > ops_actual_date
                          THEN client_communication_date ELSE ops_actual_date END)
                 BETWEEN '${s}' AND '${e}')
            OR
            (phd.is_construction_linked IS DISTINCT FROM TRUE
             AND client_communication_date IS NOT NULL
             AND DATE(client_communication_date) BETWEEN '${s}' AND '${e}')
          )
    GROUP BY o.slug, o.name, l.city, DATE(o.maal_laao_at + INTERVAL '330 minutes'),
             phd.step, p.name, ops_actual_date, ops_budget_date, client_communication_date,
             dt.id, phd.id, sub_phase, dt.status, payment_due_date, is_construction_linked, is_subsidiary
),

milestone_collection_refund AS (
    SELECT p.id,
           CASE WHEN transaction_type = 'collection' THEN SUM((t.breakdown->>'base_amount')::float) END AS base_amount_paid,
           CASE WHEN transaction_type = 'refund' THEN SUM((t.breakdown->>'base_amount')::float) END AS refund_base_amount,
           t.development_delivery_timeline_id AS did,
           DATE(t.payment_date + INTERVAL '330 minutes') AS payment_date,
           DATE(t.updated_at  + INTERVAL '330 minutes') AS payment_updated_at
    FROM development_opportunity_properties op
    INNER JOIN development_properties p ON op.development_property_id = p.id
    INNER JOIN development_opportunities o ON op.development_opportunity_id = o.id
    INNER JOIN development_delivery_timelines dt ON dt.development_opportunity_property_id = op.id
    LEFT  JOIN development_delivery_timeline_details t ON dt.id = t.development_delivery_timeline_id
    WHERE p.active = TRUE AND dt.deleted_at IS NULL AND t.deleted_at IS NULL AND ${loc}
    GROUP BY p.id, t.development_delivery_timeline_id,
             DATE(t.updated_at + INTERVAL '330 minutes'),
             DATE(t.payment_date + INTERVAL '330 minutes'), transaction_type
),

milestone_actual_pending AS (
    SELECT mb.property, mb.delivery_timeline_id, mb.stage_name, mb.base_amount,
           SUM(COALESCE(mcr.base_amount_paid, 0)) AS base_amount_paid,
           SUM(COALESCE(mcr.refund_base_amount, 0)) AS refund_base_amount,
           CASE WHEN mb.stage_name = 'Excess collection'
                THEN (-1) * COALESCE(mb.base_amount, 0)
                ELSE COALESCE(mb.base_amount, 0)
                     - SUM(COALESCE(mcr.base_amount_paid, 0))
                     + SUM(COALESCE(mcr.refund_base_amount, 0)) END AS actual_pending
    FROM milestone_base_data mb
    LEFT JOIN milestone_collection_refund mcr ON mb.did = mcr.did
    GROUP BY mb.property, mb.delivery_timeline_id, mb.stage_name, mb.base_amount
),

property_actual_pending AS (
    SELECT property, SUM(actual_pending) AS variance_actual_pending
    FROM milestone_actual_pending
    GROUP BY property
),

-- ── Isprava final metrics ─────────────────────────────────────────────────────
isprava_metrics AS (
    SELECT bd.property,
           COALESCE(lc.budget_amount, 0) + COALESCE(lp.budget_amount, 0) AS budgeted_lytd_plan,
           COALESCE(la.collected_amount, 0) + COALESCE(lr.refund_amount, 0) AS actuals_lytd_collected,
           COALESCE(lr.refund_amount, 0) AS actuals_lytd_refunds,
           COALESCE(la.collected_amount, 0) AS revised_budget_lytd,
           COALESCE(yc.budget_amount, 0) + COALESCE(yp.budget_amount, 0) AS budgeted_ytd_plan,
           ((COALESCE(lcr.budget_amount, 0) + COALESCE(lp.budget_amount, 0))
              - COALESCE(la.collected_amount, 0))
           + (COALESCE(ycr.budget_amount, 0) + COALESCE(yp.budget_amount, 0)) AS revised_ytd_budget_plan,
           COALESCE(ya.collected_amount, 0) AS actuals_ytd_collected,
           COALESCE(yr.refund_amount, 0) AS actuals_ytd_refunds,
           COALESCE(ya.collected_amount, 0) + COALESCE(yr.refund_amount, 0) AS net_actuals_ytd,
           COALESCE(pap.variance_actual_pending, 0) - COALESCE(fep.early_payment_amount, 0) AS variance
    FROM isprava_base_data bd
    LEFT JOIN lytd_construction          lc  ON bd.property = lc.property
    LEFT JOIN lytd_construction_revised  lcr ON bd.property = lcr.property
    LEFT JOIN lytd_payment               lp  ON bd.property = lp.property
    LEFT JOIN lytd_collected             la  ON bd.property = la.property
    LEFT JOIN lytd_refunds               lr  ON bd.property = lr.property
    LEFT JOIN ytd_construction           yc  ON bd.property = yc.property
    LEFT JOIN ytd_construction_revised   ycr ON bd.property = ycr.property
    LEFT JOIN ytd_payment                yp  ON bd.property = yp.property
    LEFT JOIN ytd_collected              ya  ON bd.property = ya.property
    LEFT JOIN ytd_refunds                yr  ON bd.property = yr.property
    LEFT JOIN future_budget_early_payment fep ON bd.property = fep.property
    LEFT JOIN property_actual_pending    pap ON bd.property = pap.property
),

-- ==================== CHAPTER SECTION ====================

chapter_base_data AS (
    SELECT p.name AS property
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    WHERE p.include_in_reports = TRUE AND backed_out_at IS NULL AND ${loc}
),

chapter_lytd_payment AS (
    SELECT p.name AS property,
           SUM(CASE WHEN phd.step = 'Excess collection'
                    THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS budget_amount
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_locations l ON l.id = p.chapter_location_id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN chapter_delivery_timeline_phases ph ON dt.chapter_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN chapter_opportunity_property_bank_accounts opba
           ON opba.chapter_opportunity_property_id = op.id
          AND opba.chapter_delivery_timeline_phase_id = dt.chapter_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN chapter_bank_accounts ON opba.chapter_bank_account_id = chapter_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND dt.client_communication_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_lytd_collected AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS collected_amount
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    LEFT  JOIN chapter_bank_accounts ON chapter_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_lytd_refunds AS (
    SELECT p.name AS property,
           SUM(CASE WHEN t.transaction_type = 'refund'
                    THEN (-1) * COALESCE((t.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((t.breakdown->>'base_amount')::float, 0) END) AS refund_amount
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
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_ytd_payment AS (
    SELECT p.name AS property,
           SUM(CASE WHEN phd.step = 'Excess collection'
                    THEN (-1) * COALESCE((dt.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((dt.breakdown->>'base_amount')::float, 0) END) AS budget_amount
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_locations l ON l.id = p.chapter_location_id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN chapter_delivery_timeline_phases ph ON dt.chapter_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN chapter_opportunity_property_bank_accounts opba
           ON opba.chapter_opportunity_property_id = op.id
          AND opba.chapter_delivery_timeline_phase_id = dt.chapter_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN chapter_bank_accounts ON opba.chapter_bank_account_id = chapter_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND dt.client_communication_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_ytd_collected AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS collected_amount
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    LEFT  JOIN chapter_bank_accounts ON chapter_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_ytd_refunds AS (
    SELECT p.name AS property,
           SUM(CASE WHEN t.transaction_type = 'refund'
                    THEN (-1) * COALESCE((t.breakdown->>'base_amount')::float, 0)
                    ELSE COALESCE((t.breakdown->>'base_amount')::float, 0) END) AS refund_amount
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
      AND t.payment_date BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY p.name
),

chapter_future_budget_early_payment AS (
    SELECT p.name AS property,
           SUM((t.breakdown->>'base_amount')::float) AS early_payment_amount
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN chapter_delivery_timeline_phases ph ON dt.chapter_delivery_timeline_phase_id = ph.id
    LEFT  JOIN chapter_bank_accounts ON chapter_bank_accounts.id =
              CASE WHEN t.account_type ~ '^[0-9]+$' THEN t.account_type::int ELSE NULL END
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND t.deleted_at IS NULL AND p.active = TRUE
      AND t.transaction_type = 'collection'
      AND t.payment_date < dt.client_communication_date
      AND dt.client_communication_date > CURRENT_DATE
      AND ${loc}
    GROUP BY p.name
),

chapter_milestone_base_data AS (
    SELECT o.slug, o.name, dt.id AS delivery_timeline_id, l.city AS location,
           DATE(o.maal_laao_at + INTERVAL '330 minutes') AS sales_date,
           p.name AS property, phd.step AS stage_name,
           SUM((dt.breakdown->>'base_amount')::float) AS base_amount,
           SUM((dt.breakdown->>'gst_amount')::float) AS gst_amount,
           SUM((dt.breakdown->>'stamp_duty_amount')::float) AS stamp_duty_amount,
           SUM((dt.breakdown->>'registration_amount')::float) AS registration_amount,
           SUM((dt.breakdown->>'tds_amount')::float) AS tds_amount,
           SUM(dt.total_amount) AS total_amount,
           dt.id AS did, ops_budget_date, ops_actual_date, client_communication_date,
           payment_due_date, phd.id AS phdid, sub_phase,
           is_construction_linked, is_subsidiary, dt.status AS delivery_tracker_status
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_locations l ON l.id = p.chapter_location_id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_phase_details phd ON dt.chapter_delivery_timeline_phase_detail_id = phd.id
    INNER JOIN chapter_delivery_timeline_phases ph ON dt.chapter_delivery_timeline_phase_id = ph.id
    LEFT  JOIN staffs ON staffs.id = o.post_sales_exec_id
    LEFT  JOIN chapter_opportunity_property_bank_accounts opba
           ON opba.chapter_opportunity_property_id = op.id
          AND opba.chapter_delivery_timeline_phase_id = dt.chapter_delivery_timeline_phase_id
          AND opba.account_type = 'base'
    LEFT  JOIN chapter_bank_accounts ON opba.chapter_bank_account_id = chapter_bank_accounts.id
    WHERE p.include_in_reports = TRUE AND p.deleted_at IS NULL AND dt.deleted_at IS NULL
      AND DATE(client_communication_date) BETWEEN '${s}' AND '${e}'
      AND ${loc}
    GROUP BY o.slug, o.name, l.city, DATE(o.maal_laao_at + INTERVAL '330 minutes'),
             phd.step, p.name, ops_actual_date, ops_budget_date, client_communication_date,
             dt.id, phd.id, sub_phase, dt.status, payment_due_date, is_construction_linked, is_subsidiary
),

chapter_milestone_collection_refund AS (
    SELECT p.id,
           CASE WHEN transaction_type = 'collection' THEN SUM((t.breakdown->>'base_amount')::float) END AS base_amount_paid,
           CASE WHEN transaction_type = 'refund' THEN SUM((t.breakdown->>'base_amount')::float) END AS refund_base_amount,
           t.chapter_delivery_timeline_id AS did,
           DATE(t.payment_date + INTERVAL '330 minutes') AS payment_date,
           DATE(t.updated_at  + INTERVAL '330 minutes') AS payment_updated_at
    FROM chapter_opportunity_properties op
    INNER JOIN chapter_properties p ON op.chapter_property_id = p.id
    INNER JOIN chapter_opportunities o ON op.chapter_opportunity_id = o.id
    INNER JOIN chapter_delivery_timelines dt ON dt.chapter_opportunity_property_id = op.id
    LEFT  JOIN chapter_delivery_timeline_details t ON dt.id = t.chapter_delivery_timeline_id
    WHERE p.active = TRUE AND dt.deleted_at IS NULL AND t.deleted_at IS NULL AND ${loc}
    GROUP BY p.id, t.chapter_delivery_timeline_id,
             DATE(t.updated_at + INTERVAL '330 minutes'),
             DATE(t.payment_date + INTERVAL '330 minutes'), transaction_type
),

chapter_milestone_actual_pending AS (
    SELECT mb.property, mb.delivery_timeline_id, mb.stage_name, mb.base_amount,
           SUM(COALESCE(mcr.base_amount_paid, 0)) AS base_amount_paid,
           SUM(COALESCE(mcr.refund_base_amount, 0)) AS refund_base_amount,
           CASE WHEN mb.stage_name = 'Excess collection'
                THEN (-1) * COALESCE(mb.base_amount, 0)
                ELSE COALESCE(mb.base_amount, 0)
                     - SUM(COALESCE(mcr.base_amount_paid, 0))
                     + SUM(COALESCE(mcr.refund_base_amount, 0)) END AS actual_pending
    FROM chapter_milestone_base_data mb
    LEFT JOIN chapter_milestone_collection_refund mcr ON mb.did = mcr.did
    GROUP BY mb.property, mb.delivery_timeline_id, mb.stage_name, mb.base_amount
),

chapter_property_actual_pending AS (
    SELECT property, SUM(actual_pending) AS variance_actual_pending
    FROM chapter_milestone_actual_pending
    GROUP BY property
),

chapter_metrics AS (
    SELECT bd.property,
           COALESCE(lp.budget_amount, 0) AS budgeted_lytd_plan,
           COALESCE(la.collected_amount, 0) AS actuals_lytd_collected,
           COALESCE(lr.refund_amount, 0) AS actuals_lytd_refunds,
           COALESCE(la.collected_amount, 0) AS revised_budget_lytd,
           COALESCE(yp.budget_amount, 0) AS budgeted_ytd_plan,
           (COALESCE(lp.budget_amount, 0) - COALESCE(la.collected_amount, 0))
             + COALESCE(yp.budget_amount, 0) AS revised_ytd_budget_plan,
           COALESCE(ya.collected_amount, 0) AS actuals_ytd_collected,
           COALESCE(yr.refund_amount, 0) AS actuals_ytd_refunds,
           COALESCE(ya.collected_amount, 0) + COALESCE(yr.refund_amount, 0) AS net_actuals_ytd,
           COALESCE(pap.variance_actual_pending, 0) - COALESCE(fep.early_payment_amount, 0) AS variance
    FROM chapter_base_data bd
    LEFT JOIN chapter_lytd_payment               lp  ON bd.property = lp.property
    LEFT JOIN chapter_lytd_collected             la  ON bd.property = la.property
    LEFT JOIN chapter_lytd_refunds               lr  ON bd.property = lr.property
    LEFT JOIN chapter_ytd_payment                yp  ON bd.property = yp.property
    LEFT JOIN chapter_ytd_collected              ya  ON bd.property = ya.property
    LEFT JOIN chapter_ytd_refunds                yr  ON bd.property = yr.property
    LEFT JOIN chapter_future_budget_early_payment fep ON bd.property = fep.property
    LEFT JOIN chapter_property_actual_pending    pap ON bd.property = pap.property
),

-- ==================== COMBINED UNION ====================
combined_union AS (
    SELECT property, budgeted_ytd_plan, revised_ytd_budget_plan,
           net_actuals_ytd, variance, actuals_ytd_refunds
    FROM isprava_metrics
    UNION ALL
    SELECT property, budgeted_ytd_plan, revised_ytd_budget_plan,
           net_actuals_ytd, variance, actuals_ytd_refunds
    FROM chapter_metrics
)

SELECT
    property,
    COALESCE(SUM(budgeted_ytd_plan),       0) AS ytd_planned_budget,
    COALESCE(SUM(revised_ytd_budget_plan), 0) AS normalised_budget,
    COALESCE(SUM(net_actuals_ytd),         0) AS collections,
    COALESCE(SUM(variance),                0) AS variance,
    COALESCE(SUM(actuals_ytd_refunds),     0) AS ytd_refunds
FROM combined_union
GROUP BY property
ORDER BY property;
`;

  return { sql, params: [] };
}
