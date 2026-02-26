import fs from "fs";
import path from "path";
import { logger } from "../../shared/observability/src/logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface QueryEntry {
  title: string;
  sql: string;
  tokens: string[];
}

// ── Path ───────────────────────────────────────────────────────────────────

const DATABASE_DIR = process.env.DATABASE_DIR || "/app/database";
const CSV_PATH = path.join(DATABASE_DIR, "schema", "QueriesSheet1.csv");

// ── In-memory cache ────────────────────────────────────────────────────────

let _catalog: QueryEntry[] | null = null;

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

/** Split a string into lowercase word tokens, stripping punctuation. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load and cache the predefined query catalog from QueriesSheet1.csv.
 */
export function loadQueryCatalog(): QueryEntry[] {
  if (_catalog) return _catalog;

  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(
      `Predefined query catalog not found at ${CSV_PATH}. ` +
      `Ensure DATABASE_DIR is set correctly.`
    );
  }

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  _catalog = parseCsv(raw);
  logger.info(`Loaded ${_catalog.length} predefined queries from ${CSV_PATH}`);
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
  const searchTokens = tokenize(searchTerm);
  if (searchTokens.length === 0) return [];

  const results: MatchResult[] = [];

  for (const entry of catalog) {
    let matched = 0;
    for (const st of searchTokens) {
      const hit = entry.tokens.some(
        (tt) => tt.includes(st) || st.includes(tt),
      );
      if (hit) matched++;
    }
    const score = matched / searchTokens.length;
    if (score > 0) {
      results.push({ entry, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
