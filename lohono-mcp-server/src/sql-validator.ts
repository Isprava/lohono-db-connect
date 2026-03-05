/**
 * SQL validation and sanitization for dynamic queries.
 *
 * Uses node-sql-parser for AST-level validation with a regex fallback
 * for complex Postgres-specific syntax (CTEs, :: casts, etc.)
 */

import { logger } from "../../shared/observability/src/logger.js";

const DEFAULT_LIMIT = 500;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ValidationResult {
  safe: boolean;
  sanitizedSql: string;
  tables: string[];
  error?: string;
  limitApplied?: boolean;
}

// ── Blocked keywords (DML/DDL) ──────────────────────────────────────────────

const BLOCKED_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b/i;

// ── Table name extraction (regex-based, works with any SQL) ─────────────────

/**
 * Extract table names from SQL using regex.
 * Matches FROM and JOIN clauses.
 */
export function extractTableNames(sql: string): string[] {
  const tables = new Set<string>();
  const pattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    const skipWords = new Set([
      "select", "where", "on", "as", "set", "values", "into", "lateral",
      "unnest", "generate_series", "json_array_elements", "jsonb_array_elements",
    ]);
    if (!skipWords.has(name)) {
      tables.add(name);
    }
  }
  return Array.from(tables);
}

// ── AST-based validation (primary path) ─────────────────────────────────────

function tryAstValidation(sql: string): ValidationResult | null {
  try {
    // Dynamic import to handle cases where node-sql-parser might not be installed
    const { Parser } = require("node-sql-parser");
    const parser = new Parser();

    const ast = parser.astify(sql, { database: "PostgresQL" });
    const stmts = Array.isArray(ast) ? ast : [ast];

    // Check all statements are SELECT
    for (const stmt of stmts) {
      if (stmt.type !== "select") {
        return {
          safe: false,
          sanitizedSql: sql,
          tables: [],
          error: `Only SELECT queries allowed, got: ${stmt.type?.toUpperCase() || "UNKNOWN"}`,
        };
      }
    }

    // Extract tables
    let tables: string[] = [];
    try {
      const tableList = parser.tableList(sql, { database: "PostgresQL" });
      tables = tableList.map((t: string) => {
        // Format: "select::schema::table" or "select::null::table"
        const parts = t.split("::");
        return parts[parts.length - 1];
      });
    } catch {
      tables = extractTableNames(sql);
    }

    // Check for LIMIT and inject if missing
    const mainStmt = stmts[stmts.length - 1];
    let limitApplied = false;
    if (!mainStmt.limit) {
      mainStmt.limit = {
        separator: "",
        value: [{ type: "number", value: DEFAULT_LIMIT }],
      };
      limitApplied = true;
    }

    // Convert back to SQL
    const sanitizedSql = parser.sqlify(
      stmts.length === 1 ? stmts[0] : stmts,
      { database: "PostgresQL" }
    );

    return { safe: true, sanitizedSql, tables, limitApplied };
  } catch {
    // AST parsing failed — fall through to regex validation
    return null;
  }
}

// ── Regex-based validation (fallback for complex Postgres SQL) ───────────────

function regexValidation(sql: string): ValidationResult {
  const trimmed = sql.trim();

  // Must start with SELECT or WITH (CTEs)
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    return {
      safe: false,
      sanitizedSql: sql,
      tables: [],
      error: `Query must start with SELECT or WITH. Got: "${trimmed.substring(0, 30)}..."`,
    };
  }

  // Block DML/DDL statements anywhere at statement boundaries
  // Check each semicolon-separated statement
  const statements = trimmed.split(";").filter((s) => s.trim());
  for (const stmt of statements) {
    if (BLOCKED_STATEMENT_PATTERN.test(stmt)) {
      const keyword = stmt.trim().split(/\s+/)[0].toUpperCase();
      return {
        safe: false,
        sanitizedSql: sql,
        tables: [],
        error: `${keyword} statements are not allowed. Only SELECT queries are permitted.`,
      };
    }
  }

  // Extract table names
  const tables = extractTableNames(trimmed);

  // Auto-append LIMIT if not present
  let sanitizedSql = trimmed;
  let limitApplied = false;

  // Remove trailing semicolon for LIMIT check
  const sqlNoSemicolon = sanitizedSql.replace(/;\s*$/, "");
  if (!/\bLIMIT\s+\d+/i.test(sqlNoSemicolon)) {
    sanitizedSql = `${sqlNoSemicolon}\nLIMIT ${DEFAULT_LIMIT}`;
    limitApplied = true;
  }

  logger.info("SQL validation: AST parse failed, using regex fallback", {
    tableCount: tables.length,
    limitApplied,
  });

  return { safe: true, sanitizedSql, tables, limitApplied };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate and sanitize a SQL query.
 *
 * Attempts AST-based validation first (node-sql-parser).
 * Falls back to regex-based validation for complex Postgres syntax.
 *
 * Guarantees:
 * - Only SELECT / WITH...SELECT queries pass
 * - DML/DDL is blocked
 * - LIMIT is auto-injected if missing (default 500)
 * - Table names are extracted for logging/auditing
 */
export function validateAndSanitize(sql: string): ValidationResult {
  // Try AST-based validation first
  const astResult = tryAstValidation(sql);
  if (astResult) return astResult;

  // Fall back to regex validation
  return regexValidation(sql);
}
