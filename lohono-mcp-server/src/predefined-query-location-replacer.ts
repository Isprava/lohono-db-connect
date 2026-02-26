/**
 * Injects location filters into predefined SQL queries by modifying
 * location table JOIN conditions.
 *
 * Handles two join patterns found in the predefined queries:
 *   - Single-line: JOIN development_locations l ON l.id = p.development_location_id
 *   - Multi-line:  JOIN development_locations l\n        ON l.id = p.development_location_id
 *
 * LEFT JOINs are converted to INNER JOINs when filtering, so that rows
 * without a matching location are excluded (not returned as 'Unclassified').
 */

/**
 * Escape a location string for safe use inside a SQL ILIKE pattern literal.
 * - Single quotes are doubled (SQL string escaping)
 * - Backslashes are doubled (LIKE escape char)
 */
function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * Build the ILIKE condition for one or more locations.
 * E.g. for ["Goa", "Alibaug"]:
 *   (l.city ILIKE '%Goa%' OR l.city ILIKE '%Alibaug%')
 */
function buildLocationCondition(locations: string[]): string {
  const parts = locations.map(
    (loc) => `l.city ILIKE '%${escapeSqlLike(loc)}%'`,
  );
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * Inject location ILIKE filters into a predefined SQL query.
 *
 * Strategy: find every JOIN to `development_locations l` or `chapter_locations l`
 * and append `AND l.city ILIKE '%<loc>%'` to the ON condition. LEFT JOINs are
 * promoted to INNER JOINs so that non-matching locations are excluded entirely.
 *
 * Returns the original SQL unchanged if no location joins are found or if
 * `locations` is empty.
 */
export function injectLocationFilter(
  sql: string,
  locations?: string[],
): string {
  if (!locations || locations.length === 0) return sql;

  const condition = buildLocationCondition(locations);

  // Match both single-line and multi-line JOIN patterns:
  //   (LEFT|INNER) JOIN (development|chapter)_locations l ON l.id = p.<col>_location_id
  //   (LEFT|INNER) JOIN (development|chapter)_locations l\n   ON l.id = p.<col>_location_id
  const joinRe =
    /(LEFT\s+JOIN|INNER\s+JOIN)\s+((?:development|chapter)_locations)\s+l(\s+|\s*\n\s*)ON\s+(l\.id\s*=\s*p\.\w+_location_id)/gi;

  return sql.replace(
    joinRe,
    (_match, joinType: string, table: string, ws: string, onCond: string) => {
      // Promote LEFT JOIN → INNER JOIN when filtering by location
      const newJoinType = "INNER JOIN";
      return `${newJoinType} ${table} l${ws}ON ${onCond} AND ${condition}`;
    },
  );
}
