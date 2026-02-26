import fs from "fs";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TableColumn {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: string;
  column_default: string | null;
  constraint_type: string | null;
}

export interface TableDefinition {
  schema: string;
  name: string;
  type: string;
  columns: TableColumn[];
}

export interface ForeignKeyRelationship {
  table: string;
  column: string;
  references_table: string;
  references_column: string;
  relationship_type: string;
  cardinality: string;
  nullable: boolean;
  description?: string;
  business_context?: string | Record<string, string>;
  join_example?: string;
  common_alias?: string;
  polymorphic?: boolean;
  polymorphic_type_column?: string;
  polymorphic_type_value?: string;
  note?: string;
  common_values?: string[];
  other_possible_types?: string[];
}

export interface ForeignKeyCatalog {
  metadata: {
    database: string;
    schema: string;
    generated_at: string;
    version: string;
    purpose: string;
  };
  foreign_keys: ForeignKeyRelationship[];
  inverse_relationships?: unknown[];
}

// ── Paths ──────────────────────────────────────────────────────────────────

function resolveDatabaseDir(): string {
  if (process.env.DATABASE_DIR) return process.env.DATABASE_DIR;
  const candidates = [
    path.resolve("database"),
    path.resolve(__dirname, "../../../database"),
    "/app/database",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "schema"))) return dir;
  }
  return "/app/database";
}

const DATABASE_DIR = resolveDatabaseDir();
const SCHEMA_DIR = path.join(DATABASE_DIR, "schema");
const DATABASE_CATALOG_PATH = path.join(SCHEMA_DIR, "database-catalog.json");
const FOREIGN_KEYS_CATALOG_PATH = path.join(
  SCHEMA_DIR,
  "foreign-keys-catalog.json"
);

// ── Cache ──────────────────────────────────────────────────────────────────

let _databaseCatalog: TableDefinition[] | null = null;
let _foreignKeysCatalog: ForeignKeyCatalog | null = null;

// ── Loaders ────────────────────────────────────────────────────────────────

/**
 * Load the complete database catalog (all table definitions with columns).
 */
export function loadDatabaseCatalog(): TableDefinition[] {
  if (_databaseCatalog) return _databaseCatalog;

  if (!fs.existsSync(DATABASE_CATALOG_PATH)) {
    throw new Error(
      `Database catalog not found at ${DATABASE_CATALOG_PATH}. Run: npx tsx database/scripts/catalog-tables-direct.ts`
    );
  }

  const raw = fs.readFileSync(DATABASE_CATALOG_PATH, "utf-8");
  _databaseCatalog = JSON.parse(raw) as TableDefinition[];
  return _databaseCatalog;
}

/**
 * Load the foreign key relationships catalog.
 */
export function loadForeignKeysCatalog(): ForeignKeyCatalog {
  if (_foreignKeysCatalog) return _foreignKeysCatalog;

  if (!fs.existsSync(FOREIGN_KEYS_CATALOG_PATH)) {
    throw new Error(
      `Foreign keys catalog not found at ${FOREIGN_KEYS_CATALOG_PATH}`
    );
  }

  const raw = fs.readFileSync(FOREIGN_KEYS_CATALOG_PATH, "utf-8");
  _foreignKeysCatalog = JSON.parse(raw) as ForeignKeyCatalog;
  return _foreignKeysCatalog;
}

// ── Query helpers ──────────────────────────────────────────────────────────

/**
 * Get the definition for a specific table.
 */
export function getTableDefinition(tableName: string): TableDefinition | null {
  const catalog = loadDatabaseCatalog();
  return catalog.find((t) => t.name === tableName) || null;
}

/**
 * Search for tables by name pattern (case-insensitive substring match).
 */
export function searchTables(pattern: string): TableDefinition[] {
  const catalog = loadDatabaseCatalog();
  const lowerPattern = pattern.toLowerCase();
  return catalog.filter((t) => t.name.toLowerCase().includes(lowerPattern));
}

/**
 * Get all foreign keys for a specific table (both outgoing and incoming).
 */
export function getTableRelationships(tableName: string): {
  outgoing: ForeignKeyRelationship[];
  incoming: ForeignKeyRelationship[];
} {
  const fkCatalog = loadForeignKeysCatalog();

  const outgoing = fkCatalog.foreign_keys.filter((fk) => fk.table === tableName);
  const incoming = fkCatalog.foreign_keys.filter(
    (fk) => fk.references_table === tableName
  );

  return { outgoing, incoming };
}

/**
 * Get all tables with their column counts, sorted by number of columns.
 */
export function getTablesSummary(): Array<{
  name: string;
  type: string;
  column_count: number;
}> {
  const catalog = loadDatabaseCatalog();
  return catalog
    .map((t) => ({
      name: t.name,
      type: t.type,
      column_count: t.columns.length,
    }))
    .sort((a, b) => b.column_count - a.column_count);
}

/**
 * Get complete schema context for SQL generation - includes table definitions
 * and foreign key relationships.
 */
export function getSchemaContext(tableNames: string[]): {
  tables: Record<string, TableDefinition>;
  foreign_keys: ForeignKeyRelationship[];
} {
  const catalog = loadDatabaseCatalog();
  const fkCatalog = loadForeignKeysCatalog();

  const tables: Record<string, TableDefinition> = {};
  const relevantFks: ForeignKeyRelationship[] = [];

  for (const tableName of tableNames) {
    const tableDef = catalog.find((t) => t.name === tableName);
    if (tableDef) {
      tables[tableName] = tableDef;

      // Collect all foreign keys related to this table
      const fks = fkCatalog.foreign_keys.filter(
        (fk) =>
          fk.table === tableName ||
          fk.references_table === tableName
      );
      relevantFks.push(...fks);
    }
  }

  return { tables, foreign_keys: relevantFks };
}

/**
 * Find tables that have a specific column name.
 */
export function findTablesByColumn(columnName: string): Array<{
  table: string;
  column: TableColumn;
}> {
  const catalog = loadDatabaseCatalog();
  const results: Array<{ table: string; column: TableColumn }> = [];

  for (const table of catalog) {
    const column = table.columns.find((c) => c.column_name === columnName);
    if (column) {
      results.push({ table: table.name, column });
    }
  }

  return results;
}

/**
 * Get all tables that are part of a relationship chain (e.g., development_opportunities -> stages).
 */
export function getRelationshipChain(
  startTable: string,
  maxDepth: number = 2
): string[] {
  const fkCatalog = loadForeignKeysCatalog();
  const visited = new Set<string>();
  const queue: Array<{ table: string; depth: number }> = [
    { table: startTable, depth: 0 },
  ];

  while (queue.length > 0) {
    const { table, depth } = queue.shift()!;

    if (visited.has(table) || depth > maxDepth) continue;
    visited.add(table);

    // Find all related tables
    const related = fkCatalog.foreign_keys.filter(
      (fk) => fk.table === table || fk.references_table === table
    );

    for (const fk of related) {
      const nextTable =
        fk.table === table ? fk.references_table : fk.table;
      if (!visited.has(nextTable)) {
        queue.push({ table: nextTable, depth: depth + 1 });
      }
    }
  }

  return Array.from(visited);
}

/**
 * Get metadata about the database catalog.
 */
export function getCatalogMetadata(): {
  database_catalog: {
    path: string;
    exists: boolean;
    table_count?: number;
  };
  foreign_keys_catalog: {
    path: string;
    exists: boolean;
    relationship_count?: number;
    metadata?: ForeignKeyCatalog["metadata"];
  };
} {
  const dbCatalogExists = fs.existsSync(DATABASE_CATALOG_PATH);
  const fkCatalogExists = fs.existsSync(FOREIGN_KEYS_CATALOG_PATH);

  return {
    database_catalog: {
      path: DATABASE_CATALOG_PATH,
      exists: dbCatalogExists,
      table_count: dbCatalogExists ? loadDatabaseCatalog().length : undefined,
    },
    foreign_keys_catalog: {
      path: FOREIGN_KEYS_CATALOG_PATH,
      exists: fkCatalogExists,
      relationship_count: fkCatalogExists
        ? loadForeignKeysCatalog().foreign_keys.length
        : undefined,
      metadata: fkCatalogExists
        ? loadForeignKeysCatalog().metadata
        : undefined,
    },
  };
}
