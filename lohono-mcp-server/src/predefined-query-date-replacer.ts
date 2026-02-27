/**
 * Replaces date expressions in predefined SQL queries with values derived
 * from the user-provided (or auto-computed) startDate / endDate boundaries.
 *
 * Two classes of replacement:
 *  1. Hardcoded FY 2025-26 date literals ('2025-04-01', '2025-02-28', etc.)
 *     are swapped for the correct current-FY equivalents.
 *  2. Dynamic expressions NOW() and CURRENT_DATE are replaced with anchored
 *     values (TIMESTAMP '<endDate> 00:00:00' and DATE '<endDate>') so that
 *     MTD queries produce the same result regardless of when PostgreSQL
 *     executes them (avoids the 18:30 UTC midnight-IST drift problem).
 *
 * Default dates are always computed from today's IST date so that stale
 * hardcoded dates in the CSV queries are never left untouched.
 */

/** Get today's date in IST (UTC + 5:30). */
export function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return formatDate(istDate);
}

/**
 * Compute the current FY start date (April 1).
 * Jan–Mar → FY started the previous calendar year.
 * Apr–Dec → FY started the current calendar year.
 */
export function getCurrentFYStart(todayIST?: string): string {
  const today = todayIST || getTodayIST();
  const d = new Date(today + "T00:00:00");
  const month = d.getMonth(); // 0-indexed
  const fyStartYear = month < 3 ? d.getFullYear() - 1 : d.getFullYear();
  return `${fyStartYear}-04-01`;
}

/**
 * Compute default date boundaries based on the current IST date.
 * Used when no explicit dates are provided to the predefined query tool.
 */
export function computeDefaultDates(): { startDate: string; endDate: string } {
  const endDate = getTodayIST();
  const startDate = getCurrentFYStart(endDate);
  return { startDate, endDate };
}

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

  // Replace dynamic NOW() and CURRENT_DATE with values anchored to endDate.
  //
  // Without this, MTD queries use date_part('day', now() + interval '330 minutes')
  // as their upper day-of-month bound. After 18:30 UTC on any given day (= midnight IST
  // of the next day), now() + 330min crosses a UTC day boundary, causing date_part to
  // return the NEXT day's number and silently pulling in the next IST day's records.
  //
  // Fix: replace NOW() with TIMESTAMP '<endDate> 00:00:00' and CURRENT_DATE with
  // DATE '<endDate>'. This anchors the query to endDate at the Node.js call site,
  // matching the behaviour of get_sales_funnel's explicit parameterized bounds.
  //
  // All downstream expressions remain correct:
  //   date_part('day', TIMESTAMP '2026-02-27 00:00:00' + interval '330 minutes') = 27 ✓
  //   date_trunc('month', DATE '2026-02-27' + interval '330 minutes') = 2026-02-01 ✓
  //   now() - interval '1 year' → TIMESTAMP '2025-02-27 00:00:00' ✓
  result = result.replace(/\bNOW\s*\(\s*\)/gi, `TIMESTAMP '${endDate} 00:00:00'`);
  result = result.replace(/\bCURRENT_DATE\b/gi, `DATE '${endDate}'`);

  return result;
}
