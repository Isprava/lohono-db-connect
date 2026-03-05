import { z } from "zod";
import fs from "fs";
import path from "path";
import type { ToolPlugin, ToolResult } from "./types.js";
import { logger } from "../../../shared/observability/src/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface FilterableField {
  column: string;
  type: "enum" | "date_range" | "numeric_range" | "boolean" | "text" | "jsonb";
  description: string;
}

interface KnowledgeBaseEntry {
  name: string;
  description: string;
  sql: string;
  tables_used: string[];
  filterable_fields?: Record<string, FilterableField[]>;
  vertical: string | null;
  tags: string[];
  embedding: number[];
}

// ── Load knowledge base (once, cached in memory) ────────────────────────────

let _knowledgeBase: KnowledgeBaseEntry[] | null = null;

function resolveKnowledgeBasePath(): string {
  if (process.env.DATABASE_DIR) {
    return path.join(process.env.DATABASE_DIR, "schema", "query-knowledge-base.json");
  }
  const candidates = [
    path.resolve("database/schema/query-knowledge-base.json"),
    path.resolve(__dirname, "../../../../database/schema/query-knowledge-base.json"),
    "/app/database/schema/query-knowledge-base.json",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function loadKnowledgeBase(): KnowledgeBaseEntry[] {
  if (_knowledgeBase) return _knowledgeBase;

  const kbPath = resolveKnowledgeBasePath();
  if (!fs.existsSync(kbPath)) {
    logger.warn(`Query knowledge base not found at ${kbPath}. search_example_queries will return empty results.`);
    _knowledgeBase = [];
    return _knowledgeBase;
  }

  const raw = fs.readFileSync(kbPath, "utf-8");
  _knowledgeBase = JSON.parse(raw) as KnowledgeBaseEntry[];
  logger.info(`Loaded ${_knowledgeBase.length} entries from query knowledge base`);
  return _knowledgeBase;
}

// ── Hybrid scoring: weighted keyword + tag matching ─────────────────────────
// Pure JS, zero native dependencies, works on Alpine.
// Combines token overlap (like existing matchQueries) with tag boosting
// and description matching for better semantic-like results.

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// Expand common abbreviations for better matching
const EXPANSIONS: Record<string, string[]> = {
  ytd: ["year", "to", "date", "ytd"],
  lytd: ["last", "year", "to", "date", "lytd"],
  mtd: ["month", "to", "date", "mtd"],
  lymtd: ["last", "year", "month", "to", "date", "lymtd"],
  fy: ["financial", "year", "fiscal", "fy"],
  ltv: ["lifetime", "value", "ltv"],
  aov: ["average", "order", "value", "aov"],
};

function expandTokens(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const t of tokens) {
    expanded.push(t);
    if (EXPANSIONS[t]) {
      expanded.push(...EXPANSIONS[t]);
    }
  }
  return [...new Set(expanded)];
}

function scoreEntry(queryTokens: string[], entry: KnowledgeBaseEntry): number {
  const nameTokens = tokenize(entry.name);
  const descTokens = tokenize(entry.description);

  // Build filterable field tokens from field descriptions
  const filterTokens: string[] = [];
  if (entry.filterable_fields) {
    for (const fields of Object.values(entry.filterable_fields)) {
      for (const f of fields) {
        filterTokens.push(...tokenize(f.description), ...tokenize(f.column));
      }
    }
  }

  let score = 0;
  let maxPossible = queryTokens.length;

  for (const qt of queryTokens) {
    // Exact match in name (highest weight)
    if (nameTokens.some((nt) => nt === qt)) {
      score += 1.0;
    }
    // Exact match in tags
    else if (entry.tags.includes(qt)) {
      score += 0.8;
    }
    // Exact match in filterable field descriptions
    else if (filterTokens.some((ft) => ft === qt)) {
      score += 0.7;
    }
    // Exact match in description
    else if (descTokens.some((dt) => dt === qt)) {
      score += 0.6;
    }
    // Partial substring match in name
    else if (nameTokens.some((nt) => nt.includes(qt) || qt.includes(nt))) {
      score += 0.4;
    }
    // Partial match in filterable fields
    else if (filterTokens.some((ft) => ft.includes(qt) || qt.includes(ft))) {
      score += 0.3;
    }
    // Partial match in description
    else if (descTokens.some((dt) => dt.includes(qt) || qt.includes(dt))) {
      score += 0.2;
    }
  }

  // Bonus: penalize entries with many unmatched name tokens (prefer precise matches)
  const unmatchedRatio = nameTokens.filter(
    (nt) => !queryTokens.some((qt) => nt === qt || nt.includes(qt) || qt.includes(nt))
  ).length / Math.max(nameTokens.length, 1);
  score -= unmatchedRatio * 0.3;

  return Math.max(0, score / maxPossible);
}

// ── Input schema ────────────────────────────────────────────────────────────

const SearchExampleQueriesInputSchema = z.object({
  question: z.string().min(1, "question is required"),
  limit: z.number().int().min(1).max(10).optional().default(5),
  vertical: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// ── Plugin ──────────────────────────────────────────────────────────────────

export const searchExampleQueriesPlugin: ToolPlugin = {
  definition: {
    name: "search_example_queries",
    description:
      `Search the query knowledge base for similar SQL queries. ` +
      `Provide a natural-language question and this tool returns the most relevant example queries ` +
      `with their SQL, tables used, and match scores. Use the returned queries as templates ` +
      `when writing new SQL — they demonstrate correct joins, filters, and table usage patterns. ` +
      `Optionally filter by vertical (isprava, lohono_stays, the_chapter) or tags (funnel, scorecard, mtd, ytd, lytd, conversion, leads, prospects, repeat_guests, ltv).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "Natural-language question to search for similar queries.",
        },
        limit: {
          type: "number",
          description: "Number of results to return (1-10, default 5).",
        },
        vertical: {
          type: "string",
          description: "Optional vertical filter: isprava, lohono_stays, the_chapter, solene.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag filters (e.g. ['funnel', 'ytd']). Results must match at least one tag.",
        },
      },
      required: ["question"],
    },
  },

  async handler(args): Promise<ToolResult> {
    const parsed = SearchExampleQueriesInputSchema.parse(args);
    const { question, limit, vertical, tags } = parsed;
    const startTime = Date.now();

    logger.info("search_example_queries called", { question, limit, vertical, tags });

    try {
      const kb = loadKnowledgeBase();

      if (kb.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              question,
              resultCount: 0,
              results: [],
              note: "Query knowledge base is empty. Run: npx tsx database/scripts/seed-query-knowledge-base.ts",
            }, null, 2),
          }],
        };
      }

      // Tokenize and expand the question
      const rawTokens = tokenize(question);
      const queryTokens = expandTokens(rawTokens);

      // Filter by vertical and tags if specified
      let candidates = kb;

      if (vertical) {
        candidates = candidates.filter((e) => e.vertical === vertical);
      }

      if (tags && tags.length > 0) {
        candidates = candidates.filter((e) =>
          e.tags.some((t) => tags.includes(t))
        );
      }

      // Score each candidate
      const scored = candidates.map((entry) => ({
        entry,
        score: scoreEntry(queryTokens, entry),
      }));

      // Sort by score descending, take top N
      scored.sort((a, b) => b.score - a.score);
      const topResults = scored.slice(0, limit).filter((r) => r.score > 0.1);

      const results = topResults.map((r) => ({
        name: r.entry.name,
        description: r.entry.description,
        sql: r.entry.sql,
        tables_used: r.entry.tables_used,
        filterable_fields: r.entry.filterable_fields || {},
        vertical: r.entry.vertical,
        tags: r.entry.tags,
        score: r.score.toFixed(4),
      }));

      const executionMs = Date.now() - startTime;
      logger.info("search_example_queries completed", {
        question,
        candidateCount: candidates.length,
        resultCount: results.length,
        topScore: results[0]?.score,
        executionMs,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            question,
            resultCount: results.length,
            results,
          }, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("search_example_queries failed", { error: message, question });
      return {
        content: [{ type: "text", text: `Error searching example queries: ${message}` }],
        isError: true,
      };
    }
  },
};

export const exampleQuerySearchPlugins: ToolPlugin[] = [searchExampleQueriesPlugin];
