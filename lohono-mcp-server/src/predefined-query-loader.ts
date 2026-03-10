import fs from "fs";
import path from "path";
import { logger } from "../../shared/observability/src/logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface QueryEntry {
  title: string;
  sql: string;
  tokens: string[];
  variant?: "with_extensions" | "without_extensions";
}

// ── Path ───────────────────────────────────────────────────────────────────

function resolveDatabaseDir(): string {
  if (process.env.DATABASE_DIR) return process.env.DATABASE_DIR;
  // Try common local paths before falling back to Docker path
  const candidates = [
    path.resolve("database"),          // CWD/database
    path.resolve(__dirname, "../../../database"),  // relative to compiled output
    "/app/database",                   // Docker default
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "schema"))) return dir;
  }
  return "/app/database";
}

const DATABASE_DIR = resolveDatabaseDir();
const CSV_PATHS = [
  path.join(DATABASE_DIR, "schema", "QueriesSheet1.csv"),
  path.join(DATABASE_DIR, "schema", "QueriesSheet2.csv"),
  path.join(DATABASE_DIR, "schema", "QueriesSheet3.csv"),
];

// ── In-memory cache ────────────────────────────────────────────────────────

let _catalog: QueryEntry[] | null = null;

// ── SQL fixups ─────────────────────────────────────────────────────────────

/**
 * Convert bare `JOIN x` (no ON clause) to `CROSS JOIN x`.
 *
 * Redash-resolved CTEs often produce single-row results that the original
 * dashboard combined implicitly. PostgreSQL requires explicit CROSS JOIN.
 */
function fixBareJoins(sql: string): string {
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Only target lines that start with JOIN (ignoring leading whitespace)
    // and do NOT already contain an ON clause on the same line
    if (/^\s*join\s+/i.test(lines[i]) && !/\bon\b/i.test(lines[i])) {
      // Check if the next non-empty line starts with ON
      let nextNonEmpty = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextNonEmpty = lines[j];
          break;
        }
      }
      if (!/^\s*on\b/i.test(nextNonEmpty)) {
        lines[i] = lines[i].replace(/\bjoin\b/i, "CROSS JOIN");
      }
    }
  }
  return lines.join("\n");
}

/**
 * Rewrite Redash view references to production tables.
 *
 * The Redash environment has views (`activities` with extra columns,
 * `opportunities` as a union view) that don't exist in production PostgreSQL.
 * This rewrites the problematic CTE pattern (query_1 from Redash) to use
 * the real `tasks`, `activities`, and `rental_opportunities` tables.
 *
 * Guard: only applies when SQL contains Redash view indicators.
 */
function rewriteRedashViews(sql: string): string {
  // Guard: only apply when SQL contains Redash view indicators
  if (
    !sql.includes("activities.opportunity_slug") &&
    !/FROM\s+activities[\s\S]*?JOIN\s+opportunities\b/i.test(sql)
  ) {
    return sql;
  }

  // Step 1: JOIN restructuring (must happen before column replacements)
  sql = sql.replace(
    /FROM\s+activities\s+INNER\s+JOIN\s+opportunities\s+ON\s+activities\.opportunity_slug\s*=\s*opportunities\.slug/gi,
    "FROM tasks\n   INNER JOIN activities ON tasks.id = activities.feedable_id\n   INNER JOIN rental_opportunities ON rental_opportunities.id = activities.leadable_id",
  );

  // Step 2: WHERE clause fix
  sql = sql.replace(
    /WHERE\s+opportunities\.type\s*=\s*'Rental::Opportunity'/gi,
    "WHERE activities.feedable_type = 'Task'\n     AND activities.leadable_type = 'Rental::Opportunity'",
  );

  // Step 3: Column replacements (prefixed references)
  sql = sql.replace(/activities\.resolved_at/g, "tasks.performed_at");
  sql = sql.replace(/activities\.opportunity_slug/g, "rental_opportunities.slug");
  sql = sql.replace(/activities\.rating/g, "tasks.rating");

  // Step 4: Bare column references (negative lookbehind to skip already-prefixed)
  // Replace bare `enquired_at` with table-qualified version.
  sql = sql.replace(/(?<!\w\.)enquired_at/g, "rental_opportunities.enquired_at");

  // Step 5: Replace bare `opportunity_slug` contextually.
  // In inner subquery SELECT lists: alias it so outer queries can reference it.
  // In outer contexts (e.g. array_agg): keep the bare name (references subquery output).
  // In PARTITION BY / other contexts inside subqueries: table-qualify it.
  //
  // Strategy: first alias the standalone SELECT-list item, then replace remaining
  // bare references with the table-qualified form. The aliased column ensures
  // outer queries that reference `opportunity_slug` still work.
  sql = sql.replace(
    /^(\s*)(?<!\w\.)opportunity_slug\s*,/gm,
    "$1rental_opportunities.slug AS opportunity_slug,",
  );
  // Remaining bare opportunity_slug in function args like array_agg(opportunity_slug)
  // reference subquery output — leave them as `opportunity_slug` (now aliased above).
  // Only replace bare opportunity_slug that is NOT inside parentheses (i.e., not a
  // function argument referencing subquery output).
  sql = sql.replace(
    /(?<!\w\.)(?<!AS )opportunity_slug(?!\s*,)(?!\s*\))/g,
    "rental_opportunities.slug",
  );

  return sql;
}

// ── CSV parser ─────────────────────────────────────────────────────────────

/**
 * Parse the QueriesSheet1.csv into an array of { title, sql, tokens }.
 *
 * Format: each record is `Title,"SQL..."` where SQL is a quoted CSV field
 * spanning multiple lines. Internal double-quotes are escaped as `""`.
 * Records are separated by the pattern: closing `"` then a new line
 * containing `,"` which marks the next title boundary.
 */
function parseCsv(content: string): QueryEntry[] {
  const entries: QueryEntry[] = [];
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Find lines that start a new record: contain `,"` with title before it
    const sepIdx = line.indexOf(',"');
    if (sepIdx === -1) {
      i++;
      continue;
    }

    const title = line.substring(0, sepIdx).trim();
    if (!title) {
      i++;
      continue;
    }

    // Collect the SQL: everything after `,"` on this line, plus subsequent
    // lines until we find the closing unescaped `"`
    let sqlParts: string[] = [line.substring(sepIdx + 2)]; // after `,"`
    i++;

    // Scan forward until we find the closing quote
    let closed = isQuotedFieldClosed(sqlParts[0]);
    while (!closed && i < lines.length) {
      // Check if the next line starts a new record (title,"...)
      const nextSep = lines[i].indexOf(',"');
      const candidateTitle = nextSep !== -1 ? lines[i].substring(0, nextSep).trim() : "";
      // A new record starts if the line has `,"` and the part before it
      // looks like a title (contains letters, not pure SQL)
      if (nextSep !== -1 && candidateTitle && looksLikeTitle(candidateTitle)) {
        // The previous record's SQL wasn't properly closed — trim and close it
        break;
      }

      sqlParts.push(lines[i]);
      closed = isQuotedFieldClosed(sqlParts.join("\n"));
      i++;
    }

    let sql = sqlParts.join("\n");

    // Strip trailing closing quote
    if (sql.endsWith('"')) {
      sql = sql.slice(0, -1);
    }

    // Unescape CSV double-quote escaping: "" → "
    sql = sql.replaceAll('""', '"');
    sql = sql.trim();

    // Fix bare JOINs (no ON clause) → CROSS JOIN
    // Redash-resolved CTEs produce single-row results joined together;
    // PostgreSQL requires explicit CROSS JOIN for these.
    sql = fixBareJoins(sql);

    // Rewrite Redash view references (activities/opportunities) to
    // production tables (tasks/activities/rental_opportunities).
    sql = rewriteRedashViews(sql);

    // Fix integer overflow: cast(... as int) → cast(... as bigint)
    // Some aggregate sums (e.g. GMV totals) exceed 32-bit int range.
    sql = sql.replace(/\bas\s+int\s*\)/gi, "as bigint)");


    if (sql) {
      entries.push({
        title,
        sql,
        tokens: tokenize(title),
      });
    }
  }

  return entries;
}

/**
 * Check if a CSV quoted field is closed (ends with `"` but not `""`).
 */
function isQuotedFieldClosed(s: string): boolean {
  if (!s.endsWith('"')) return false;
  // Count trailing quotes — odd number means the field is closed
  let count = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '"'; i--) {
    count++;
  }
  return count % 2 === 1;
}

/**
 * Heuristic: a string looks like a title if it contains at least one letter
 * and does NOT start with common SQL keywords.
 */
function looksLikeTitle(s: string): boolean {
  if (!/[a-zA-Z]/.test(s)) return false;
  const lower = s.toLowerCase().trimStart();
  const sqlStarts = ["select", "with", "insert", "update", "delete", "create", "drop", "alter", "from", "where", "and", "or", "left", "inner", "join", "case", "sum(", "count(", "group", "order", "having", "union", "else", "end", "when", "then", "as "];
  return !sqlStarts.some((kw) => lower.startsWith(kw));
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

/** Common filler/stop words that dilute search scores when users type
 *  natural-language prompts like "show me the booking data". */
const STOP_WORDS = new Set([
  "show", "me", "the", "a", "an", "of", "for", "and", "or", "in", "on",
  "to", "is", "it", "my", "get", "give", "fetch", "find", "list", "all",
  "please", "can", "you", "i", "want", "need", "see", "data", "report",
  "details", "info", "information", "current", "latest", "today", "now",
  "this", "that", "with", "from", "by", "what", "how", "which", "their",
  "our", "has", "have", "are", "was", "were", "be", "been", "do", "does",
]);

/** Split a string into lowercase word tokens, stripping punctuation. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Tokenize a search query, removing stop words that dilute matching scores.
 *  Falls back to full tokens if ALL words are stop words. */
function tokenizeSearch(s: string): string[] {
  const all = tokenize(s);
  const filtered = all.filter((t) => !STOP_WORDS.has(t));
  return filtered.length > 0 ? filtered : all;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load and cache the predefined query catalog from all CSV files.
 */
export function loadQueryCatalog(): QueryEntry[] {
  if (_catalog) return _catalog;

  const available = CSV_PATHS.filter(fs.existsSync);
  if (available.length === 0) {
    throw new Error(
      `Predefined query catalog not found. Looked in: ${CSV_PATHS.join(", ")}. ` +
      `Ensure DATABASE_DIR is set correctly.`
    );
  }

  const all: QueryEntry[] = [];
  for (const csvPath of available) {
    const raw = fs.readFileSync(csvPath, "utf-8").replaceAll("\r\n", "\n");
    const entries = parseCsv(raw);
    logger.info(`Loaded ${entries.length} predefined queries from ${csvPath}`);

    // Tag QueriesSheet2 entries: 1-11 = with_extensions, 12-22 = without_extensions
    if (csvPath.endsWith("QueriesSheet2.csv")) {
      const midpoint = 11;
      entries.forEach((entry, idx) => {
        entry.variant = idx < midpoint ? "with_extensions" : "without_extensions";
      });
    }

    all.push(...entries);
  }

  _catalog = all;
  return _catalog;
}

export interface MatchResult {
  entry: QueryEntry;
  score: number;
}

/**
 * Fuzzy-match a search term against query titles using token overlap.
 *
 * Scoring: for each search token, check if any title token contains it
 * (or vice versa). Score = matched_search_tokens / total_search_tokens.
 *
 * Returns matches sorted by score descending, filtered to score > 0.
 */
export function matchQueries(
  searchTerm: string,
  catalog: QueryEntry[],
): MatchResult[] {
  const searchTokens = tokenizeSearch(searchTerm);
  if (searchTokens.length === 0) return [];

  const results: MatchResult[] = [];

  // Date-period keywords that must match exactly — "mtd" must NOT
  // partially match "lymtd", "ytd" must NOT match "lytd", etc.
  const DATE_KEYWORDS = new Set(["mtd", "ytd", "lytd", "lymtd", "lmtd", "fy", "weekly"]);

  /** Naive plural stemming: strip trailing 's' for comparison.
   *  "bookings" → "booking", "leads" → "lead", etc. */
  const stem = (t: string) => t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;

  for (const entry of catalog) {
    let score = 0;
    for (const st of searchTokens) {
      if (entry.tokens.some((tt) => tt === st || stem(tt) === stem(st))) {
        // Exact token match (or plural match) — full weight
        score += 1;
      } else if (DATE_KEYWORDS.has(st)) {
        // Date keyword with no exact match — skip partial matching
        // so "mtd" doesn't match "lymtd"
        score += 0;
      } else if (entry.tokens.some((tt) => {
        // Don't let search token partially match a date keyword
        if (DATE_KEYWORDS.has(tt)) return false;
        return tt.includes(st) || st.includes(tt);
      })) {
        // Partial substring match — half weight
        score += 0.5;
      }
    }
    const normalizedScore = score / searchTokens.length;
    if (normalizedScore > 0) {
      results.push({ entry, score: normalizedScore });
    }
  }

  // Primary sort: score descending.
  // Tiebreaker: shorter titles first — a query whose title has fewer unmatched
  // tokens is a more precise match (e.g. "Closed Leads - Isprava" wins over
  // "Closed Leads YTD- Isprava" when the search has no "ytd" token).
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    return a.entry.tokens.length - b.entry.tokens.length;
  });
  return results;
}
