/**
 * Replaces hardcoded FY 2025-26 date literals in predefined SQL queries
 * with user-provided date boundaries.
 *
 * Dynamic expressions (CURRENT_DATE, NOW(), date_trunc(...)) are left
 * untouched — they're already relative to execution time.
 */

/** Shift a YYYY-MM-DD date string by a number of years. */
function shiftYears(dateStr: string, years: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setFullYear(d.getFullYear() + years);
  return formatDate(d);
}

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the FY end date (March 31) for a given FY start date.
 * If startDate is 2025-04-01, FY end is 2026-03-31.
 */
function computeFyEnd(startDate: string): string {
  const d = new Date(startDate + "T00:00:00");
  // FY end = next year March 31 (assuming start is April 1)
  return `${d.getFullYear() + 1}-03-31`;
}

/**
 * Compute the first day of the month for a given end date.
 * E.g. 2025-02-28 → 2025-02-01, but the CSV uses '2025-03-01'
 * which is the month start for March. We map it relative to the FY end.
 */
function computeMonthStart(fyEnd: string): string {
  const d = new Date(fyEnd + "T00:00:00");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Replace hardcoded date literals in SQL with dates derived from
 * the user-provided startDate and endDate.
 *
 * The original queries use FY 2025-26 dates:
 *   '2025-04-01' — FY start
 *   '2025-02-28' — period end (MTD/YTD cutoff)
 *   '2024-04-01' — LYTD FY start (previous year)
 *   '2025-03-31' — FY end
 *   '2025-03-01' — FY end month start
 *   '2023-04-01' — FY start minus 2 years
 *   '2022-04-01' — FY start minus 3 years
 *
 * All replacements use literal string matching on 'YYYY-MM-DD' values.
 */
export function replaceDatesInSql(
  sql: string,
  startDate: string,
  endDate: string,
): string {
  const fyEnd = computeFyEnd(startDate);
  const fyEndMonthStart = computeMonthStart(fyEnd);

  // Previous year equivalents
  const prevStartDate = shiftYears(startDate, -1);
  const prevEndDate = shiftYears(endDate, -1);
  const prevFyEnd = computeFyEnd(prevStartDate);
  const prevFyEndMonthStart = computeMonthStart(prevFyEnd);

  // Build replacement map: original literal → new literal
  const replacements: [string, string][] = [
    // Current FY
    ["'2025-04-01'", `'${startDate}'`],
    ["'2025-02-28'", `'${endDate}'`],
    ["'2025-03-31'", `'${fyEnd}'`],
    ["'2025-03-01'", `'${fyEndMonthStart}'`],
    // Previous FY (LYTD)
    ["'2024-04-01'", `'${prevStartDate}'`],
    ["'2024-02-28'", `'${prevEndDate}'`],
    ["'2024-03-31'", `'${prevFyEnd}'`],
    ["'2024-03-01'", `'${prevFyEndMonthStart}'`],
    // Older FY starts (for multi-year comparisons)
    ["'2023-04-01'", `'${shiftYears(startDate, -2)}'`],
    ["'2022-04-01'", `'${shiftYears(startDate, -3)}'`],
  ];

  let result = sql;
  for (const [original, replacement] of replacements) {
    result = result.replaceAll(original, replacement);
  }

  return result;
}
