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
 *
 * When `exclude` is true, builds NOT ILIKE conditions with AND:
 *   (l.city NOT ILIKE '%Goa%' AND l.city NOT ILIKE '%Alibaug%')
 */
function buildLocationCondition(locations: string[], exclude = false): string {
  if (exclude) {
    const parts = locations.map(
      (loc) => `l.city NOT ILIKE '%${escapeSqlLike(loc)}%'`,
    );
    return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
  }
  const parts = locations.map(
    (loc) => `l.city ILIKE '%${escapeSqlLike(loc)}%'`,
  );
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * Inject location ILIKE filters into a predefined SQL query.
 *
 * Strategy: find every JOIN to `development_locations l` or `chapter_locations l`
 * and append `AND l.city ILIKE '%<loc>%'` (or NOT ILIKE for exclusions) to the
 * ON condition. LEFT JOINs are promoted to INNER JOINs so that non-matching
 * locations are excluded (not returned as 'Unclassified').
 *
 * Returns the original SQL unchanged if no location joins are found or if
 * both `locations` and `excludeLocations` are empty.
 */
export function injectLocationFilter(
  sql: string,
  locations?: string[],
  excludeLocations?: string[],
): string {
  const hasInclude = locations && locations.length > 0;
  const hasExclude = excludeLocations && excludeLocations.length > 0;
  if (!hasInclude && !hasExclude) return sql;

  const conditions: string[] = [];
  if (hasInclude) conditions.push(buildLocationCondition(locations));
  if (hasExclude) conditions.push(buildLocationCondition(excludeLocations, true));
  const condition = conditions.join(" AND ");

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
