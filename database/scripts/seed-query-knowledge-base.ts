/**
 * Generate the query knowledge base JSON file from CSV query catalogs.
 *
 * Parses QueriesSheet1.csv and QueriesSheet2.csv, generates embeddings
 * for each query using all-MiniLM-L6-v2, and writes the result to
 * database/schema/query-knowledge-base.json
 *
 * Usage:
 *   npx tsx database/scripts/seed-query-knowledge-base.ts
 *
 * Re-run this script whenever you add new queries to the CSV files.
 */

import fs from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

const CSV_DIR = path.resolve("database/schema");
const CSV_FILES = ["QueriesSheet1.csv", "QueriesSheet2.csv"];
const OUTPUT_PATH = path.join(CSV_DIR, "query-knowledge-base.json");

// ── Embedding loader (lazy) ─────────────────────────────────────────────────

let pipelineInstance: any = null;

async function getEmbeddingPipeline() {
  if (pipelineInstance) return pipelineInstance;
  console.log(`Loading embedding model: ${EMBEDDING_MODEL}...`);
  const start = Date.now();
  const { pipeline } = await import("@xenova/transformers");
  pipelineInstance = await pipeline("feature-extraction", EMBEDDING_MODEL);
  console.log(`Model loaded in ${Date.now() - start}ms`);
  return pipelineInstance;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIMENSIONS);
}

// ── CSV parser (replicates predefined-query-loader logic) ───────────────────

interface ParsedQuery {
  title: string;
  sql: string;
  variant?: "with_extensions" | "without_extensions";
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
  const sqlStarts = [
    "select", "with", "insert", "update", "delete", "create", "drop", "alter",
    "from", "where", "and", "or", "left", "inner", "join", "case", "sum(",
    "count(", "group", "order", "having", "union", "else", "end", "when",
    "then", "as ", "--", "cross",
  ];
  return !sqlStarts.some((kw) => lower.startsWith(kw));
}

function parseCsv(content: string): ParsedQuery[] {
  const entries: ParsedQuery[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const sepIdx = line.indexOf(',"');
    if (sepIdx === -1) { i++; continue; }

    const title = line.substring(0, sepIdx).trim();
    if (!title) { i++; continue; }

    let sqlParts: string[] = [line.substring(sepIdx + 2)];
    i++;

    let closed = isQuotedFieldClosed(sqlParts[0]);
    while (!closed && i < lines.length) {
      const nextSep = lines[i].indexOf(',"');
      const candidateTitle = nextSep !== -1 ? lines[i].substring(0, nextSep).trim() : "";
      if (nextSep !== -1 && candidateTitle && looksLikeTitle(candidateTitle)) break;
      sqlParts.push(lines[i]);
      closed = isQuotedFieldClosed(sqlParts.join("\n"));
      i++;
    }

    let sql = sqlParts.join("\n");
    if (sql.endsWith('"')) sql = sql.slice(0, -1);
    sql = sql.replaceAll('""', '"').trim();
    sql = sql.replace(/\bas\s+int\s*\)/gi, "as bigint)");

    if (sql) entries.push({ title, sql });
  }

  return entries;
}

// ── Extract table names from SQL (regex-based) ─────────────────────────────

function extractTableNames(sql: string): string[] {
  const tables = new Set<string>();
  const pattern = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    const skipWords = new Set(["select", "where", "on", "as", "set", "values", "into", "lateral"]);
    if (!skipWords.has(name)) {
      tables.add(name);
    }
  }
  return Array.from(tables);
}

// ── Derive tags from title ──────────────────────────────────────────────────

function deriveTags(title: string): string[] {
  const tags: string[] = [];
  const lower = title.toLowerCase();

  if (lower.includes("mtd")) tags.push("mtd");
  if (lower.includes("ytd")) tags.push("ytd");
  if (lower.includes("lytd") || lower.includes("lymtd")) tags.push("lytd");
  if (lower.includes("funnel")) tags.push("funnel");
  if (lower.includes("scorecard") || lower.includes("score card")) tags.push("scorecard");
  if (lower.includes("conversion")) tags.push("conversion");
  if (lower.includes("leads") || lower.includes("lead")) tags.push("leads");
  if (lower.includes("prospects") || lower.includes("prospect")) tags.push("prospects");
  if (lower.includes("accounts") || lower.includes("account")) tags.push("accounts");
  if (lower.includes("sales") || lower.includes("sale")) tags.push("sales");
  if (lower.includes("weekly")) tags.push("weekly");
  if (lower.includes("repeat")) tags.push("repeat_guests");
  if (lower.includes("ltv") || lower.includes("aov")) tags.push("ltv");
  if (lower.includes("isprava")) tags.push("isprava");
  if (lower.includes("chapter")) tags.push("the_chapter");
  if (lower.includes("lohono")) tags.push("lohono_stays");
  if (lower.includes("consolidated")) tags.push("consolidated");
  if (lower.includes("ageing") || lower.includes("aging")) tags.push("ageing");
  if (lower.includes("orderbook")) tags.push("orderbook");
  if (lower.includes("bifurcation") || lower.includes("source")) tags.push("source_bifurcation");
  if (lower.includes("open")) tags.push("open");
  if (lower.includes("closed")) tags.push("closed");

  return tags;
}

// ── Table filterable fields mapping ─────────────────────────────────────────
// Maps each table to its filterable columns + filter type for richer embeddings

interface FilterableField {
  column: string;
  type: "enum" | "date_range" | "numeric_range" | "boolean" | "text" | "jsonb";
  description: string;
}

const TABLE_FILTERABLE_FIELDS: Record<string, FilterableField[]> = {
  development_opportunities: [
    { column: "current_stage", type: "enum", description: "stage: enquiry, prospect, account" },
    { column: "status", type: "enum", description: "status: open, closed" },
    { column: "interested_location", type: "enum", description: "location: Goa, Alibaug, Coonoor" },
    { column: "enquired_at", type: "date_range", description: "enquiry date" },
    { column: "source", type: "enum", description: "lead source: Google, Referral, Website" },
    { column: "source_city", type: "enum", description: "source city: Mumbai, Delhi, Bangalore" },
    { column: "source_region", type: "enum", description: "source region: North, South, West" },
    { column: "source_country", type: "enum", description: "source country" },
    { column: "min_budget", type: "numeric_range", description: "minimum budget" },
    { column: "max_budget", type: "numeric_range", description: "maximum budget" },
    { column: "min_bhk", type: "numeric_range", description: "minimum BHK" },
    { column: "max_bhk", type: "numeric_range", description: "maximum BHK" },
    { column: "interested_home_types", type: "enum", description: "home type: Villa, Apartment" },
    { column: "estimated_purchase_date", type: "date_range", description: "estimated purchase date" },
    { column: "lead_completed_at", type: "date_range", description: "lead completion date" },
    { column: "prospect_completed_at", type: "date_range", description: "prospect completion date" },
    { column: "maal_laao_at", type: "date_range", description: "site visit date" },
    { column: "registration_date", type: "date_range", description: "registration date" },
    { column: "client_communication_required", type: "boolean", description: "client communication required" },
    { column: "meta->>'utm_source'", type: "text", description: "UTM source" },
    { column: "meta->>'utm_campaign'", type: "text", description: "UTM campaign" },
    { column: "meta->>'utm_medium'", type: "text", description: "UTM medium" },
  ],
  chapter_opportunities: [
    { column: "current_stage", type: "enum", description: "stage: enquiry, prospect, account" },
    { column: "status", type: "enum", description: "status: open, closed" },
    { column: "interested_location", type: "enum", description: "location: Goa, Alibaug, Coonoor" },
    { column: "enquired_at", type: "date_range", description: "enquiry date" },
    { column: "source", type: "enum", description: "lead source: Google, Referral, Website" },
    { column: "source_city", type: "enum", description: "source city: Mumbai, Delhi, Bangalore" },
    { column: "source_region", type: "enum", description: "source region: North, South, West" },
    { column: "source_country", type: "enum", description: "source country" },
    { column: "bhk", type: "enum", description: "BHK type" },
    { column: "min_budget", type: "numeric_range", description: "minimum budget" },
    { column: "max_budget", type: "numeric_range", description: "maximum budget" },
    { column: "interested_home_types", type: "enum", description: "home type: Villa, Apartment" },
    { column: "estimated_purchase_date", type: "date_range", description: "estimated purchase date" },
    { column: "lead_completed_at", type: "date_range", description: "lead completion date" },
    { column: "prospect_completed_at", type: "date_range", description: "prospect completion date" },
    { column: "maal_laao_at", type: "date_range", description: "site visit date" },
    { column: "client_communication_required", type: "boolean", description: "client communication required" },
    { column: "meta->>'utm_source'", type: "text", description: "UTM source" },
    { column: "meta->>'utm_campaign'", type: "text", description: "UTM campaign" },
    { column: "meta->>'utm_medium'", type: "text", description: "UTM medium" },
  ],
  agents: [
    { column: "status", type: "enum", description: "agent status: active, inactive" },
    { column: "verified", type: "boolean", description: "agent verified" },
    { column: "agent_type", type: "enum", description: "agent type" },
    { column: "vertical", type: "enum", description: "vertical: development, chapter" },
    { column: "location", type: "enum", description: "agent location city" },
    { column: "company_name", type: "text", description: "agent company name" },
    { column: "source", type: "enum", description: "agent referral source" },
    { column: "source_region", type: "enum", description: "agent region" },
    { column: "commission", type: "numeric_range", description: "commission percentage" },
    { column: "discount", type: "numeric_range", description: "discount percentage" },
  ],
  staffs: [
    { column: "active", type: "boolean", description: "staff active status" },
    { column: "verticals", type: "enum", description: "verticals: development, chapter, rental" },
    { column: "role_id", type: "enum", description: "staff role" },
    { column: "head_id", type: "enum", description: "reporting manager" },
    { column: "location_ids", type: "enum", description: "staff locations" },
  ],
  stages: [
    { column: "vertical", type: "enum", description: "vertical: development, chapter" },
    { column: "code", type: "enum", description: "stage code: prospect, account, closed" },
    { column: "active", type: "boolean", description: "stage active" },
    { column: "sequence", type: "numeric_range", description: "stage order sequence" },
  ],
  stage_histories: [
    { column: "leadable_type", type: "enum", description: "lead type: Development::Opportunity, Chapter::Opportunity" },
    { column: "created_at", type: "date_range", description: "stage transition date" },
    { column: "author_id", type: "enum", description: "staff who moved the stage" },
  ],
  tasks: [
    { column: "rating", type: "enum", description: "task rating: maal_laao, closed, hot, warm, cold" },
    { column: "performed_at", type: "date_range", description: "task performed date" },
    { column: "medium_id", type: "enum", description: "communication medium: Call, Meeting, Email" },
    { column: "author_id", type: "enum", description: "task created by staff" },
    { column: "assignee_id", type: "enum", description: "task assigned to staff" },
    { column: "closed_reason", type: "jsonb", description: "closed reason and explanation" },
    { column: "deleted_at", type: "date_range", description: "soft delete date" },
  ],
  activities: [
    { column: "leadable_type", type: "enum", description: "lead type: Development::Opportunity, Chapter::Opportunity" },
    { column: "feedable_type", type: "enum", description: "activity type: Task, Note, Document" },
    { column: "deleted_at", type: "date_range", description: "soft delete date" },
    { column: "created_at", type: "date_range", description: "activity date" },
  ],
  enquiries: [
    { column: "vertical", type: "enum", description: "vertical: development, chapter" },
    { column: "enquiry_type", type: "enum", description: "enquiry type" },
    { column: "location", type: "enum", description: "enquiry location" },
    { column: "source", type: "enum", description: "enquiry source: Google, Referral, Website" },
    { column: "source_city", type: "enum", description: "source city" },
    { column: "source_region", type: "enum", description: "source region" },
    { column: "is_trash", type: "boolean", description: "trash/spam enquiry" },
    { column: "created_at", type: "date_range", description: "enquiry date" },
    { column: "leadable_id", type: "enum", description: "NULL if unconverted enquiry" },
  ],
  rental_opportunities: [
    { column: "status", type: "enum", description: "rental status" },
    { column: "check_in", type: "date_range", description: "check-in date" },
    { column: "check_out", type: "date_range", description: "check-out date" },
    { column: "source", type: "enum", description: "booking source" },
    { column: "property_id", type: "enum", description: "rental property" },
    { column: "resolved_at", type: "date_range", description: "booking resolved date" },
  ],
  opportunities: [
    { column: "status", type: "enum", description: "opportunity status" },
    { column: "current_stage", type: "enum", description: "current stage" },
    { column: "source", type: "enum", description: "opportunity source" },
    { column: "vertical", type: "enum", description: "vertical" },
  ],
  contacts: [
    { column: "name", type: "text", description: "contact name" },
    { column: "email", type: "text", description: "contact email" },
  ],
  mobiles: [
    { column: "mobile", type: "text", description: "mobile number for repeat guest matching" },
  ],
};

/**
 * Get filterable fields for a list of tables.
 * Returns deduplicated field descriptions for embedding enrichment.
 */
function getFilterableFieldsForTables(tables: string[]): { fields: Record<string, FilterableField[]>; description: string } {
  const fields: Record<string, FilterableField[]> = {};
  const descParts: string[] = [];

  for (const table of tables) {
    const tableFields = TABLE_FILTERABLE_FIELDS[table];
    if (tableFields) {
      fields[table] = tableFields;
      const fieldDescs = tableFields.map((f) => f.description);
      descParts.push(`${table}: ${fieldDescs.join(", ")}`);
    }
  }

  return { fields, description: descParts.join(" | ") };
}

// ── Derive vertical from title ──────────────────────────────────────────────

function deriveVertical(title: string): string | null {
  const lower = title.toLowerCase();
  if (lower.includes("isprava")) return "isprava";
  if (lower.includes("chapter")) return "the_chapter";
  if (lower.includes("lohono")) return "lohono_stays";
  if (lower.includes("solene")) return "solene";
  return null;
}

// ── Generate description from title (for embedding) ─────────────────────────

function generateDescription(title: string, tags: string[], filterFieldsDesc: string): string {
  const parts = [title];

  if (tags.includes("mtd")) parts.push("month to date");
  if (tags.includes("ytd")) parts.push("year to date");
  if (tags.includes("lytd")) parts.push("last year to date");
  if (tags.includes("funnel")) parts.push("sales funnel pipeline");
  if (tags.includes("scorecard")) parts.push("scorecard performance report");
  if (tags.includes("conversion")) parts.push("conversion rate");
  if (tags.includes("repeat_guests")) parts.push("repeat guest loyalty returning");
  if (tags.includes("ltv")) parts.push("lifetime value average order value");

  // Append filterable fields context for richer embeddings
  if (filterFieldsDesc) {
    parts.push("filterable by: " + filterFieldsDesc);
  }

  return parts.join(" | ");
}

// ── Knowledge base entry type ───────────────────────────────────────────────

interface KnowledgeBaseEntry {
  name: string;
  description: string;
  sql: string;
  tables_used: string[];
  filterable_fields: Record<string, FilterableField[]>;
  vertical: string | null;
  tags: string[];
  embedding: number[];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Generating query knowledge base...\n");

  const allQueries: ParsedQuery[] = [];

  for (const csvFile of CSV_FILES) {
    const csvPath = path.join(CSV_DIR, csvFile);
    if (!fs.existsSync(csvPath)) {
      console.warn(`Skipping ${csvFile} — file not found`);
      continue;
    }
    const raw = fs.readFileSync(csvPath, "utf-8").replaceAll("\r\n", "\n");
    const entries = parseCsv(raw);

    if (csvFile === "QueriesSheet2.csv") {
      const midpoint = 11;
      entries.forEach((entry, idx) => {
        entry.variant = idx < midpoint ? "with_extensions" : "without_extensions";
      });
    }

    console.log(`Parsed ${entries.length} queries from ${csvFile}`);
    allQueries.push(...entries);
  }

  console.log(`\nTotal queries: ${allQueries.length}\n`);

  const knowledgeBase: KnowledgeBaseEntry[] = [];

  for (let idx = 0; idx < allQueries.length; idx++) {
    const query = allQueries[idx];
    const name = query.variant
      ? `${query.title} [${query.variant}]`
      : query.title;

    const tablesUsed = extractTableNames(query.sql);
    const tags = deriveTags(query.title);
    const vertical = deriveVertical(query.title);
    const { fields: filterableFields, description: filterFieldsDesc } = getFilterableFieldsForTables(tablesUsed);
    const description = generateDescription(query.title, tags, filterFieldsDesc);

    const embedding = await generateEmbedding(description);

    const fieldCount = Object.values(filterableFields).reduce((sum, f) => sum + f.length, 0);

    knowledgeBase.push({
      name,
      description,
      sql: query.sql,
      tables_used: tablesUsed,
      filterable_fields: filterableFields,
      vertical,
      tags,
      embedding,
    });

    console.log(`  [${idx + 1}/${allQueries.length}] ${name} (${tablesUsed.length} tables, ${tags.length} tags, ${fieldCount} filters)`);
  }

  // Write to JSON
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(knowledgeBase, null, 2));
  const sizeKb = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);
  console.log(`\nWritten ${knowledgeBase.length} entries to ${OUTPUT_PATH} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
