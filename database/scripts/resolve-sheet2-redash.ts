/**
 * Resolve Redash query_XXX references in QueriesSheet2.csv.
 *
 * For each Sheet2 query, fetches the referenced Redash queries and inlines
 * them as CTEs, producing self-contained SQL that runs directly on PostgreSQL.
 *
 * Handles nested references: if a fetched Redash query itself references
 * other query_XXX, those are resolved recursively.
 *
 * Usage:
 *   npx tsx database/scripts/resolve-sheet2-redash.ts
 *
 * Requires REDASH_URL and REDASH_API_KEY env vars (loaded from .env).
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { RedashClient } from "../../lohono-mcp-server/src/redash-client.js";

// Load .env from project root
dotenv.config({ path: path.resolve(".", ".env") });

// ── Config ──────────────────────────────────────────────────────────────

const SHEET2_PATH = path.resolve("database/schema/QueriesSheet2.csv");
const OUTPUT_PATH = path.resolve("database/schema/QueriesSheet2_resolved.csv");

// ── CSV parser (same logic as predefined-query-loader) ──────────────────

interface RawEntry {
  title: string;
  sql: string;
}

function parseCsv(content: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const sepIdx = line.indexOf(',"');
    if (sepIdx === -1) { i++; continue; }

    const title = line.substring(0, sepIdx).trim();
    if (!title) { i++; continue; }

    const sqlParts: string[] = [line.substring(sepIdx + 2)];
    i++;

    let closed = isQuotedFieldClosed(sqlParts[0]);
    while (!closed && i < lines.length) {
      const nextSep = lines[i].indexOf(',"');
      const candidate = nextSep !== -1 ? lines[i].substring(0, nextSep).trim() : "";
      if (nextSep !== -1 && candidate && looksLikeTitle(candidate)) break;
      sqlParts.push(lines[i]);
      closed = isQuotedFieldClosed(sqlParts.join("\n"));
      i++;
    }

    let sql = sqlParts.join("\n");
    if (sql.endsWith('"')) sql = sql.slice(0, -1);
    sql = sql.replaceAll('""', '"').trim();

    if (sql) entries.push({ title, sql });
  }
  return entries;
}

function isQuotedFieldClosed(s: string): boolean {
  if (!s.endsWith('"')) return false;
  let count = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '"'; i--) count++;
  return count % 2 === 1;
}

function looksLikeTitle(s: string): boolean {
  if (!/[a-zA-Z]/.test(s)) return false;
  const lower = s.toLowerCase().trimStart();
  const sqlStarts = ["select", "with", "insert", "update", "delete", "create", "drop", "alter", "from", "where", "and", "or", "left", "inner", "join", "case", "sum(", "count(", "group", "order", "having", "union", "else", "end", "when", "then", "as "];
  return !sqlStarts.some((kw) => lower.startsWith(kw));
}

// ── CSV writer ──────────────────────────────────────────────────────────

function toCsvRow(title: string, sql: string): string {
  // Escape double quotes in SQL, wrap in quotes
  const escaped = sql.replaceAll('"', '""');
  return `${title},"${escaped}"`;
}

// ── Redash resolution ───────────────────────────────────────────────────

let redash: RedashClient;
const sqlCache = new Map<number, string>();

/** Extract all query_XXX IDs from SQL */
function extractQueryIds(sql: string): number[] {
  const ids = new Set<number>();
  for (const m of sql.matchAll(/\bquery_(\d+)\b/g)) {
    ids.add(parseInt(m[1]));
  }
  return [...ids];
}

/** Fetch a Redash query's SQL, with caching */
async function fetchRedashSql(queryId: number): Promise<string> {
  if (sqlCache.has(queryId)) return sqlCache.get(queryId)!;

  console.log(`  Fetching Redash query ${queryId}...`);
  const result = await redash.fetchQuery(queryId);
  if (!result.success || !result.query) {
    throw new Error(`Failed to fetch Redash query ${queryId}: ${result.error}`);
  }

  let sql = result.query.query.trim();

  // If the query body is empty or only comments, replace with a valid placeholder
  const nonCommentLines = sql.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("--"));
  if (nonCommentLines.length === 0) {
    console.log(`    ⚠ query_${queryId} is empty/comments-only, using SELECT NULL placeholder`);
    sql = "SELECT NULL";
  }

  sqlCache.set(queryId, sql);
  return sql;
}

/**
 * Extract the leading WITH clause CTEs from a SQL string.
 * Returns { ctes: ["name AS (...)", ...], body: "SELECT ..." }
 * PostgreSQL doesn't allow nested WITH — all CTEs must be at the top level.
 */
function extractWithClauses(sql: string): { ctes: string[]; body: string } {
  const trimmed = sql.trimStart();
  if (!/^WITH\s/i.test(trimmed)) return { ctes: [], body: sql };

  // Remove leading WITH keyword
  let rest = trimmed.replace(/^WITH\s+/i, "");
  const ctes: string[] = [];

  // Parse CTE blocks: "name AS (...)" separated by commas
  while (rest.length > 0) {
    // Match CTE name
    const nameMatch = rest.match(/^(\w+)\s+AS\s*\(/i);
    if (!nameMatch) break;

    const cteName = nameMatch[1];
    const afterName = rest.slice(nameMatch[0].length - 1); // keep opening paren

    // Find matching closing paren (handle nested parens)
    let depth = 0;
    let i = 0;
    for (; i < afterName.length; i++) {
      if (afterName[i] === "(") depth++;
      else if (afterName[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }

    const cteBody = afterName.slice(1, i); // content between parens
    ctes.push(`${cteName} AS (\n${cteBody.trim()}\n)`);

    rest = afterName.slice(i + 1).trimStart();
    // Skip comma between CTEs
    if (rest.startsWith(",")) {
      rest = rest.slice(1).trimStart();
    }
  }

  return { ctes, body: rest };
}

/**
 * Recursively resolve all query_XXX references in SQL.
 * Hoists all CTEs to a single top-level WITH clause to avoid
 * PostgreSQL's "nested WITH" syntax error.
 */
async function resolveQuery(sql: string, visited = new Set<number>()): Promise<string> {
  const ids = extractQueryIds(sql);
  if (ids.length === 0) return sql;

  const allCtes: string[] = [];

  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);

    let subSql = await fetchRedashSql(id);
    // Recursively resolve nested references first
    subSql = await resolveQuery(subSql, visited);

    // If the resolved sub-query has its own WITH clause, hoist those CTEs
    const { ctes: innerCtes, body } = extractWithClauses(subSql);
    allCtes.push(...innerCtes);

    // Add this query as a CTE using its body (WITH stripped)
    allCtes.push(`query_${id} AS (\n${body.trim()}\n)`);
  }

  if (allCtes.length === 0) return sql;

  // Strip any existing WITH from the main SQL and merge everything
  const { ctes: mainCtes, body: mainBody } = extractWithClauses(sql);
  const finalCtes = [...allCtes, ...mainCtes];

  // Deduplicate CTEs by name (keep first occurrence)
  const seen = new Set<string>();
  const uniqueCtes: string[] = [];
  for (const cte of finalCtes) {
    const name = cte.match(/^(\w+)\s+AS\s*\(/i)?.[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      uniqueCtes.push(cte);
    }
  }

  return `WITH ${uniqueCtes.join(",\n")}\n${mainBody}`;
}

// ── Redash view rewriting ────────────────────────────────────────────────

/**
 * Rewrite Redash view references to production tables.
 * Same logic as in predefined-query-loader.ts.
 */
function rewriteRedashViews(sql: string): string {
  if (
    !sql.includes("activities.opportunity_slug") &&
    !/FROM\s+activities[\s\S]*?JOIN\s+opportunities\b/i.test(sql)
  ) {
    return sql;
  }

  sql = sql.replace(
    /FROM\s+activities\s+INNER\s+JOIN\s+opportunities\s+ON\s+activities\.opportunity_slug\s*=\s*opportunities\.slug/gi,
    "FROM tasks\n   INNER JOIN activities ON tasks.id = activities.feedable_id\n   INNER JOIN rental_opportunities ON rental_opportunities.id = activities.leadable_id",
  );
  sql = sql.replace(
    /WHERE\s+opportunities\.type\s*=\s*'Rental::Opportunity'/gi,
    "WHERE activities.feedable_type = 'Task'\n     AND activities.leadable_type = 'Rental::Opportunity'",
  );
  sql = sql.replace(/activities\.resolved_at/g, "tasks.performed_at");
  sql = sql.replace(/activities\.opportunity_slug/g, "rental_opportunities.slug");
  sql = sql.replace(/activities\.rating/g, "tasks.rating");
  sql = sql.replace(/(?<!\w\.)enquired_at/g, "rental_opportunities.enquired_at");
  // Bare opportunity_slug: alias in SELECT lists, table-qualify elsewhere,
  // but leave function args (e.g. array_agg(opportunity_slug)) as-is since
  // they reference aliased subquery output.
  sql = sql.replace(
    /^(\s*)(?<!\w\.)opportunity_slug\s*,/gm,
    "$1rental_opportunities.slug AS opportunity_slug,",
  );
  sql = sql.replace(
    /(?<!\w\.)(?<!AS )opportunity_slug(?!\s*,)(?!\s*\))/g,
    "rental_opportunities.slug",
  );

  return sql;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  redash = new RedashClient();
  console.log("Reading", SHEET2_PATH);
  const raw = fs.readFileSync(SHEET2_PATH, "utf-8").replaceAll("\r\n", "\n");
  const entries = parseCsv(raw);
  console.log(`Parsed ${entries.length} queries from Sheet2\n`);

  const resolvedRows: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const ids = extractQueryIds(entry.sql);
    console.log(`[${i + 1}/${entries.length}] ${entry.title} (refs: ${ids.length > 0 ? ids.join(", ") : "none"})`);

    if (ids.length === 0) {
      // No Redash references — keep as-is
      resolvedRows.push(toCsvRow(entry.title, entry.sql));
      console.log("  → No references, kept as-is\n");
      continue;
    }

    try {
      let resolved = await resolveQuery(entry.sql);
      resolved = rewriteRedashViews(resolved);
      resolvedRows.push(toCsvRow(entry.title, resolved));
      console.log(`  → Resolved ${ids.length} references\n`);
    } catch (err) {
      console.error(`  → ERROR: ${err instanceof Error ? err.message : err}`);
      // Keep original SQL with a comment noting the failure
      resolvedRows.push(toCsvRow(entry.title, `-- UNRESOLVED: ${err instanceof Error ? err.message : err}\n${entry.sql}`));
    }
  }

  fs.writeFileSync(OUTPUT_PATH, resolvedRows.join("\n") + "\n", "utf-8");
  console.log(`\nWrote ${resolvedRows.length} resolved queries to ${OUTPUT_PATH}`);
  console.log(`Fetched ${sqlCache.size} unique Redash queries`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
