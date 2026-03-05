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

function generateDescription(title: string, tags: string[]): string {
  const parts = [title];

  if (tags.includes("mtd")) parts.push("month to date");
  if (tags.includes("ytd")) parts.push("year to date");
  if (tags.includes("lytd")) parts.push("last year to date");
  if (tags.includes("funnel")) parts.push("sales funnel pipeline");
  if (tags.includes("scorecard")) parts.push("scorecard performance report");
  if (tags.includes("conversion")) parts.push("conversion rate");
  if (tags.includes("repeat_guests")) parts.push("repeat guest loyalty returning");
  if (tags.includes("ltv")) parts.push("lifetime value average order value");

  return parts.join(" | ");
}

// ── Knowledge base entry type ───────────────────────────────────────────────

interface KnowledgeBaseEntry {
  name: string;
  description: string;
  sql: string;
  tables_used: string[];
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
    const description = generateDescription(query.title, tags);

    const embedding = await generateEmbedding(description);

    knowledgeBase.push({
      name,
      description,
      sql: query.sql,
      tables_used: tablesUsed,
      vertical,
      tags,
      embedding,
    });

    console.log(`  [${idx + 1}/${allQueries.length}] ${name} (${tablesUsed.length} tables, ${tags.length} tags)`);
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
