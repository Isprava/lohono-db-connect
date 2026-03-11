import Anthropic from "@anthropic-ai/sdk";
import { getToolsForClaude, callTool } from "./mcp-bridge.js";
import { checkUserToolAccess } from "./acl.js";
import {
  appendMessage,
  getMessages,
  updateSessionTitle,
  type Message as DbMessage,
} from "./db.js";
import { withClaudeSpan, withSpan, logInfo, logError } from "../../shared/observability/src/index.js";
import { CircuitBreaker, CircuitOpenError } from "../../shared/circuit-breaker/src/index.js";
import { RedisCache } from "../../shared/redis/src/index.js";
import { Vertical, DEFAULT_VERTICAL } from "../../shared/types/verticals.js";
import { resolveLocations } from "./location-resolver.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 20; // safety limit to avoid infinite loops
const MESSAGE_WINDOW_SIZE = 50; // max messages to send to Claude (controls token cost)

// ── Response cache (skip Claude API for identical questions) ─────────────

const HISTORICAL_RESPONSE_TTL = 86_400; // 24 hours — past data doesn't change
const CURRENT_RESPONSE_TTL = 300;       // 5 minutes — current/ambiguous data

interface CachedResponse {
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
}

const responseCache = new RedisCache<CachedResponse>("response", CURRENT_RESPONSE_TTL);

/** Normalize a user question for cache key generation. */
function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build a cache key from the user message only.
 * Vertical is intentionally excluded — Claude detects it from message content,
 * so the same question always maps to the same answer regardless of session default. */
function responseCacheKey(userMessage: string, _vertical?: Vertical): string {
  return normalizeQuestion(userMessage);
}

/**
 * Detect whether a user question refers to historical (past) dates only.
 * If so, returns a long TTL (24h); otherwise returns a short TTL (5min).
 *
 * Recognizes:
 *   - ISO dates: 2025-01-15
 *   - Month-year: "January 2025", "Jan 2025"
 *   - Relative: "last month", "last quarter", "last year"
 */
function detectResponseTTL(userMessage: string): number {
  const msg = userMessage.toLowerCase();

  // IST-aware start of current month
  const nowUtc = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffsetMs);
  const startOfMonthIst = new Date(nowIst.getFullYear(), nowIst.getMonth(), 1);

  const months: Record<string, number> = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, october: 9, oct: 9,
    november: 10, nov: 10, december: 11, dec: 11,
  };

  const detectedDates: Date[] = [];

  // ISO dates: 2025-01-15 or 2025-01-31
  for (const m of msg.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    detectedDates.push(new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  }

  // Month-year: "january 2025", "jan 2025"
  for (const m of msg.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/g)) {
    const monthIdx = months[m[1]];
    const year = parseInt(m[2]);
    // Use end of month for comparison
    detectedDates.push(new Date(year, monthIdx + 1, 0));
  }

  // Relative terms that clearly refer to the past
  if (/\b(last\s+month|previous\s+month)\b/.test(msg)) {
    detectedDates.push(new Date(nowIst.getFullYear(), nowIst.getMonth() - 1, 1));
  }
  if (/\b(last\s+quarter|previous\s+quarter)\b/.test(msg)) {
    detectedDates.push(new Date(nowIst.getFullYear(), nowIst.getMonth() - 3, 1));
  }
  if (/\b(last\s+year|previous\s+year)\b/.test(msg)) {
    detectedDates.push(new Date(nowIst.getFullYear() - 1, 0, 1));
  }

  // No dates detected → short TTL (could be about current data)
  if (detectedDates.length === 0) return CURRENT_RESPONSE_TTL;

  // All detected dates must be before current month for historical TTL
  const allHistorical = detectedDates.every(d => d < startOfMonthIst);
  return allHistorical ? HISTORICAL_RESPONSE_TTL : CURRENT_RESPONSE_TTL;
}

// ── Debug mode ──────────────────────────────────────────────────────────

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

interface DebugEntry {
  tool: string;
  input?: Record<string, unknown>;
  cacheHit?: boolean;
  sql?: string;
  params?: unknown[];
  ttl?: number;
  rowCount?: number | null;
  knowledgeBaseId?: string;
  modelArn?: string;
  question?: string;
  citationSources?: string[];
  executionMs?: number;
  [key: string]: unknown;
}

/**
 * Try to extract _debug info from a tool result string.
 * Handles two formats:
 *   1. JSON with a top-level `_debug` field (sales funnel)
 *   2. HTML comment `<!-- DEBUG_JSON:{"_debug":{...}} -->` (helpdesk/RAG)
 */
function extractDebugFromResult(resultText: string, toolName: string, toolInput: Record<string, unknown>): DebugEntry | null {
  // Format 1: JSON with _debug field
  try {
    const parsed = JSON.parse(resultText);
    if (parsed._debug) {
      return { ...parsed._debug, input: toolInput };
    }
  } catch {
    // Not JSON — try format 2
  }

  // Format 2: HTML comment with DEBUG_JSON
  const commentMatch = resultText.match(/<!-- DEBUG_JSON:(.*?) -->/);
  if (commentMatch) {
    try {
      const parsed = JSON.parse(commentMatch[1]);
      if (parsed._debug) {
        return { ...parsed._debug, input: toolInput };
      }
    } catch {
      // Malformed debug JSON
    }
  }

  return null;
}

/** Format collected debug entries as a markdown section. */
function formatDebugMarkdown(entries: DebugEntry[], responseCacheHit?: boolean, responseCacheKey?: string): string {
  const lines: string[] = ["\n\n---\n\n## Debug Information\n"];

  if (responseCacheHit) {
    lines.push("### Response Cache");
    lines.push(`- **Cache Hit:** Yes`);
    lines.push(`- **Cache Key:** \`${responseCacheKey}\``);
    lines.push(`- **Note:** Full response served from cache — no Claude API call made\n`);
  }

  for (const entry of entries) {
    lines.push(`### Tool Call: ${entry.tool}\n`);

    if (entry.input) {
      const paramStr = Object.entries(entry.input)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      lines.push(`- **Parameters:** ${paramStr}`);
    }

    lines.push(`- **Cache Hit:** ${entry.cacheHit ? "Yes" : "No"}`);

    if (entry.executionMs !== undefined) {
      lines.push(`- **Execution Time:** ${entry.executionMs}ms`);
    }

    if (entry.ttl !== undefined) {
      const ttlLabel = entry.ttl >= 86_400 ? `${entry.ttl}s (historical — 24h)` : `${entry.ttl}s`;
      lines.push(`- **TTL Applied:** ${ttlLabel}`);
    }

    if (entry.rowCount !== undefined && entry.rowCount !== null) {
      lines.push(`- **Rows Returned:** ${entry.rowCount}`);
    }

    if (entry.knowledgeBaseId) {
      lines.push(`- **Knowledge Base:** ${entry.knowledgeBaseId}`);
    }
    if (entry.modelArn) {
      lines.push(`- **Model:** ${entry.modelArn}`);
    }
    if (entry.question) {
      lines.push(`- **Question:** "${entry.question}"`);
    }
    if (entry.citationSources && entry.citationSources.length > 0) {
      lines.push(`- **Sources:** ${entry.citationSources.join(", ")}`);
    }

    if (entry.sql) {
      lines.push(`\n\`\`\`sql\n${entry.sql.trim()}\n\`\`\``);
    }

    if (entry.params && entry.params.length > 0) {
      lines.push(`\n- **Query Params:** \`${JSON.stringify(entry.params)}\``);
    }

    lines.push(""); // blank line between entries
  }

  return lines.join("\n");
}

// ── Circuit breaker for Claude API ────────────────────────────────────────

const claudeCircuitBreaker = new CircuitBreaker({
  name: "claude-api",
  failureThreshold: 3,
  resetTimeoutMs: 60_000, // 60s — API is expensive, give it time
  isTransient: (err: unknown) => {
    // Don't trip the circuit breaker for transient API errors (overloaded, rate limited)
    const msg = err instanceof Error ? err.message : String(err);
    return /overloaded_error|rate_limit_error|529|529/.test(msg);
  },
});

/** Get the current Claude API circuit breaker state for health checks */
export function getClaudeCircuitState() {
  return claudeCircuitBreaker.getState();
}

function getTodayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function buildSystemPrompt(): string {
  const today = getTodayIST();
  return `You are an expert data analyst assistant for Isprava, Chapter and  Lohono Stays.
You have access to the Lohono production database through MCP tools.

**Today's date (IST): ${today}**

**Date Resolution Rules:**
- Always use today's date (${today}) as the upper bound when the requested period has not yet ended.
- For a full calendar year that is still in progress (e.g., "2026"), use end_date: "${today}", NOT end_date: "${today.slice(0, 4)}-12-31".
- When presenting results for a partial year/quarter/month, label it as "Year to Date", "Quarter to Date", or "Month to Date" — never as "full year" or "full quarter".
- Only use a future end_date (e.g., Dec 31) if the user explicitly asks for a forecast or a projection.

**Date Abbreviation Glossary:**
When the user uses any of these abbreviations, resolve them to the corresponding date range using today's date (${today}) as the anchor. **Calendar year** = January 1 – December 31. **Fiscal year** = April 1 – March 31.

| Abbreviation | Full Name | Date Range |
|---|---|---|
| MTD | Month To Date | 1st of current month → today |
| YTD | Year To Date | Jan 1 of current year → today |
| QTD | Quarter To Date | 1st day of current quarter → today (Q1: Jan–Mar, Q2: Apr–Jun, Q3: Jul–Sep, Q4: Oct–Dec) |
| WTD | Week To Date | Monday of current week → today |
| DTD | Day To Date | today → today |
| LM | Last Month | 1st → last day of previous calendar month |
| LW | Last Week | Monday → Sunday of previous week |
| LY | Last Year | Jan 1 → Dec 31 of previous calendar year |
| LYTD | Last Year To Date | Jan 1 of last year → same calendar date last year (e.g. if today is Mar 9 2026, LYTD = Jan 1 2025 → Mar 9 2025) |
| LMYTD | Last Month Year To Date | Jan 1 of last year → last day of same month last year (YTD value as of end of that month, one year ago) |
| LQ | Last Quarter | Full previous calendar quarter (e.g. if current is Q1, LQ = Oct 1 – Dec 31 last year) |
| TTM | Trailing Twelve Months | 12 months ending today (today minus 365 days → today) |
| R12M | Rolling 12 Months | Same as TTM — 12 months ending today |
| R6M | Rolling 6 Months | 6 months ending today |
| R3M | Rolling 3 Months | 3 months ending today |
| MoM | Month over Month | Compare current MTD vs same MTD of previous month |
| YoY | Year over Year | Compare current period vs same period one year ago |
| QoQ | Quarter over Quarter | Compare current QTD vs same QTD of previous quarter |
| WoW | Week over Week | Compare current WTD vs same WTD of previous week |
| FYTD | Fiscal Year To Date | Apr 1 of current fiscal year → today |
| LFY | Last Fiscal Year | Apr 1 of last fiscal year → Mar 31 of last fiscal year end |
| LFYTD | Last Fiscal Year To Date | Apr 1 of last fiscal year → same calendar date of last fiscal year |

**Comparison abbreviations (MoM, YoY, QoQ, WoW):** When the user asks for these, compute both periods, show them side by side, and include the delta/change.

**Vertical Resolution:**
- When the user mentions "Chapter" or "chapter" (without "The"), always treat it as the \`the_chapter\` vertical.
- When the user mentions "Lohono" or "lohono" (without "Stays"), always treat it as the \`lohono_stays\` vertical.
- Always pass the canonical vertical value (\`the_chapter\`, \`lohono_stays\`, \`isprava\`, \`solene\`) to tool calls.

**Query Process:**
1. **NEVER ask for clarification before trying run_predefined_query.** For ANY data question — no matter how vague ("show me bookings", "booking data", "leads", "prospects", "GMV") — ALWAYS call run_predefined_query FIRST with the user's words as the search term. The tool has fuzzy matching against 96 predefined queries and will find a match if one exists. Do NOT ask the user to clarify, specify dates, pick a vertical, or narrow their question. Just call the tool immediately. If it finds a match, present the results. If it returns no match (below confidence threshold), THEN proceed to step 2. Do NOT use get_sales_funnel for these — the predefined query catalog contains the correct, fully-formed SQL.
   - If run_predefined_query finds a match and returns data, use that result. Do NOT call get_sales_funnel or run_dynamic_query as a follow-up for the same question.
   - **Scorecard / Consolidated Dashboard / Collection Summary / Ageing Analysis:** These queries MUST ONLY be run via run_predefined_query. NEVER write your own SQL for these — the predefined queries contain complex, validated business logic that cannot be replicated ad-hoc. Search for "scorecard consolidated", "collection summary consolidated", or "ageing analysis consolidated" respectively.
   - **Present predefined query results exactly as returned.** Do NOT reinterpret, recalculate, or rename columns. In particular, scorecard columns \`l2p\`, \`p2a\`, \`a2s\` are average **days** between stages (lead-to-prospect, prospect-to-account, account-to-sale) — NOT conversion percentages. Show the raw integer values with the label "days". Do NOT compute your own conversion rates from the counts.
   - **NEVER do arithmetic on query results yourself.** If the user asks to summarize, aggregate, group by, total, or compute averages from a previous result, ALWAYS use run_dynamic_query with a SQL GROUP BY query to compute the aggregation server-side. NEVER attempt to manually sum, average, or aggregate rows — you will get the numbers wrong. For example, if the user says "summarize by location", write a SQL query that wraps the original query logic with GROUP BY location and SUM() aggregations.
   - If run_predefined_query returns no match (no results or below confidence threshold), proceed to step 2.
   - **Repeat guest / LTV queries:** Some queries exist in two variants: "with_extensions" and "without_extensions". If the user does not specify a variant, both will be executed automatically and returned side by side. If the user specifies a variant, pass it as the variant parameter.
   - **Single-metric funnel requests:** If the user asks for a specific metric within a named funnel (e.g. "LYTD leads for chapter", "YTD prospects isprava"), use run_predefined_query for the full funnel report and extract the requested metric from the result.
   - **Date handling:** The predefined queries have their own date logic baked into the SQL. **CRITICAL: When the user's request contains a date period keyword (MTD, YTD, FYTD, LYTD, LYMTD, etc.) that matches the predefined query title, do NOT compute or pass start_date/end_date. The keyword is part of the query NAME — the SQL already has the correct date range. Pass ONLY the query search term with NO dates.** Only pass start_date/end_date when the user provides EXPLICIT calendar dates beyond the period keyword (e.g. "YTD as of February 15" → end_date='2026-02-15', "MTD for January" → end_date='2026-01-31'). If the user just says "show me X YTD" or "Non Payment Gateway Bookings MTD", omit start_date and end_date entirely.
   - **Date-required queries:** Some predefined queries (e.g. Cancellations Report) have date placeholders and REQUIRE the user to provide a date range. If run_predefined_query returns a response with \`"dates_required": true\`, ask the user for a start date and end date, then call run_predefined_query again with those dates. Do NOT use defaults for these queries — the user must explicitly provide the dates.
   - **Location filtering:** Use the \`locations\` parameter to include specific locations (e.g. locations: ['Goa']). Use the \`exclude_locations\` parameter to exclude locations (e.g. exclude_locations: ['Goa'] for "non-Goa" or "everything except Goa"). Do NOT try to list all other locations manually — use exclude_locations instead.
2. **If no predefined match → check sales funnel tools.** For standalone sales funnel metrics (Leads, Prospects, Accounts, Sales counts for a date range) that are NOT a named report, use get_sales_funnel. Date rules: if the user provides specific dates, pass start_date/end_date. If the user does NOT specify dates, omit start_date and end_date entirely — the tool defaults to the current Indian Financial Year (April 1 to today). NEVER invent a date range like "2020-01-01" or "beginning of time" — either use the user's dates or let the tool default. Location filtering is supported via the 'locations' parameter.
3. **If neither predefined nor sales funnel → use the dynamic query workflow** (see step 6 below).
4. **Identifier Preference:** When building queries that involve guest or contact identification (e.g. deduplication, lookups, joins), prefer using mobile number over email as the identifier. Mobile is more reliably populated in this database.
5. **Guest Information Rules:**
   - The \`rental_opportunities\` table has \`name\`, \`email\`, and \`mobile\` columns directly — use these for guest info instead of joining through \`opportunity_contacts\` → \`contacts\` unless you specifically need contact-only fields (e.g. \`dob\`, \`company\`, \`profession\`).
   - NEVER display internal database IDs (\`id\`, \`contact_id\`, \`opportunity_id\`, etc.) to users — these are meaningless auto-increment numbers. Instead, show \`mobile\` as the guest identifier (it is the real-world unique identifier for guests).
   - NEVER alias or rename a column to something misleading. For example, do NOT rename \`contact_id\` (an internal FK) as "Contact ID" in results — users will confuse it with a phone number. If you need a unique guest identifier column, use \`mobile\`.
   - When presenting guest-related results, always include: \`name\`, \`mobile\`, and optionally \`email\`. Omit internal IDs from the output.
6. For any data question NOT covered by predefined reports or sales funnel tools, use the dynamic query workflow:
   a. **Discover:** Call search_example_queries with the user's question to find similar SQL patterns from the knowledge base. Also call search_tables with relevant keywords to identify ALL tables that could be related to the question.
   b. **Explore:** For every table that is potentially relevant, call get_table_schema and READ EVERY COLUMN — not just the table name. Understand what each column holds, its data type, and whether it duplicates data available in another table. Do NOT skip tables — check all candidates. For example, if the question involves guests and bookings, inspect rental_opportunities, rental_reservations, rental_properties, opportunity_contacts, contacts, and any other related tables. Pay close attention to which tables already have the columns you need (e.g. rental_opportunities has name, mobile, email directly — you may not need to join contacts at all).
   c. **Analyze:** Before writing any SQL, reason carefully about the schema:
      - **Map user terms to the correct tables/columns.** Do not assume — the user's words may map to a different table than you expect. For example, "location" could mean a geographic area table, not a property table; "booking" means a confirmed reservation, not a pipeline opportunity. Read the columns you discovered in step (b) and pick the table that truly matches the user's intent.
      - **Pick the right source of truth.** Identify which table represents the actual entity the user is asking about (e.g. confirmed bookings vs pipeline stages, locations vs properties). Use that as your primary table with INNER JOINs — not LEFT JOINs that inflate counts with NULL rows.
      - **Eliminate redundant joins.** If the primary table already has the columns you need, do not join extra tables just to get the same data.
      - **Select only meaningful output columns.** Exclude internal IDs. Include human-readable identifiers (name, mobile, email) and the data the user actually asked for.
      - **Apply correct filters.** Check what status values, soft-delete columns (deleted_at IS NULL), or other conditions are needed to get accurate results.
   d. **Build:** Write the SQL query using ONLY tables and columns confirmed by the schema catalog. Follow patterns from example queries where applicable.
   e. **Validate before executing:** Re-read the user's prompt. Does your query actually answer what they asked? Check:
      - Are you querying the right entity (e.g. confirmed bookings, not just enquiries)?
      - Are you grouping/filtering by the right dimension (e.g. location vs property)?
      - Are all output columns meaningful and correctly labeled — no internal IDs, no misleading aliases?
      - Would the results make sense to a non-technical user?
   f. Call run_dynamic_query to execute the SQL
   g. If it returns a Postgres error, read the error message carefully, fix the SQL, and retry
   h. NEVER guess table or column names — always verify with get_table_schema first
7. For schema exploration, use catalog tools (get_tables_summary, search_tables, get_table_schema, etc.)
8. For questions about policies, procedures, SOPs, villa information, guest guidelines, operational documentation, or Goa building/construction regulations (DCR norms, FAR/FSI, setbacks, zoning, parking, fire safety, building heights, plot coverage, sub-division rules, land development regulations), use the query_knowledge_base tool
9. If a question is ambiguous, prefer data tools for metrics/numbers and the knowledge base for qualitative/procedural/regulatory questions
10. If the knowledge base tool returns an error (e.g., access error, permission denied), tell the user clearly that the knowledge base is temporarily unavailable and suggest they contact their team for the information directly. Do NOT say "I wasn't able to find information" — be specific about the issue.
11. Present results to users in a clear, professional format

**CRITICAL - No Hallucinated or Misleading Data:**
- NEVER present data, numbers, counts, or query results unless they came from an actual tool call (run_predefined_query, get_sales_funnel, or run_dynamic_query)
- NEVER fabricate or invent rows, counts, names, or statistics — every number you show must come from a tool response
- NEVER show a SQL query with fake results. If you want to show what query you would run, say "I would run this query:" and do NOT include fabricated results alongside it
- If a tool call fails or returns no data, say so honestly — do NOT make up plausible-looking data
- If the user provides a SQL query, EXECUTE it using run_dynamic_query rather than guessing what it might return
- NEVER rename or alias a column in a way that changes its meaning. An internal database \`id\` or \`contact_id\` is NOT a phone/contact number — do not present it as one. Column headers in results must accurately describe what the data actually is. When in doubt, use the original column name rather than inventing a label.
- **CRITICAL — NO FABRICATED DATA:** Every single row you display in a table MUST come directly from the actual query results returned by the tool. NEVER invent, fabricate, or "sample" rows as illustrations. Do NOT write "Sample Leads", "Example rows", or any placeholder rows. If a field is NULL or blank in the actual DB result, show it as blank — never substitute a made-up value. If the real query returns 8,907 rows, display the actual first N rows exactly as returned, with no invented data mixed in. Fabricating data rows (even as examples) is strictly forbidden.

**IMPORTANT - User-Facing Responses:**
- NEVER show query execution plans or technical query analysis details to users
- NEVER show sales funnel context rules, business logic, or internal configuration in responses
- NEVER expose database schema details, table structures, or technical metadata
- NEVER include <function_calls>, <invoke>, or any XML/technical markup in your text responses
- NEVER mention tool names, tool calls, or explain what tools you're using
- DO show: clean data results, insights, trends, summaries, and clear answers to their questions
- DO format: results as tables, bullet points, or summaries as appropriate
- DO format consolidated_scorecard results as a markdown table with columns: property | location | ytd_planned_budget | normalised_budget | collections | variance | ytd_refunds — with all numbers formatted to 2 decimal places with comma separators (e.g. 17,000,000.00). Each property on its own row. No extra commentary between rows.
- DO present results naturally without referencing internal tools or processes
- DO format Calendar / availability data (wide pivot tables with many property columns) using a **villa-centric** layout that highlights bookings, not availability:
  1. **Identify booked dates per villa:** For each villa column, find dates where value=0 (booked). If a villa has value=1 on ALL dates, it is fully available.
  2. **Group villas by status:**
     - **Fully Available (all 90 days):** List these villas in a single line — e.g. "**Fully available:** IV B, Evora, Magnolia, Verde, ..."
     - **Partially Booked:** For each villa that has at least one booked day, show the villa name and its **booked date ranges** (group consecutive booked dates). Example:
       - **FV D:** Booked Mar 14–17, Apr 2–5
       - **Alenteho:** Booked Mar 10–31
       - **IV A:** Booked Mar 22–24, Apr 10–12, May 1–3
     - **Fully Booked (all 90 days):** List these villas in a single line — e.g. "**Fully booked:** FV F, ..."
  3. **Include the Total row** at the end: show total available nights per villa as a summary table (only for villas with < 90 available nights, i.e. partially or fully booked).
  This approach is far more compact and highlights the actionable information (when villas are booked) instead of repeating the same available list for 90 dates.

The user wants business insights, not technical details. Keep responses focused on answering their question with clean data, summaries, and insights. NEVER show SQL queries unless the user explicitly asks for the query.`;
}

// ── Claude client (singleton) ──────────────────────────────────────────────

let anthropic: Anthropic;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 4,
    });
  }
  return anthropic;
}

function getModel(): string {
  return process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitize assistant text by removing XML-like technical markup that shouldn't
 * be shown to users (e.g., <function_calls>, <invoke>, <parameter>, etc.)
 */
export function sanitizeAssistantText(text: string): string {
  // Remove common XML-like technical tags that Claude might accidentally include
  return text
    .replace(/<function_calls>.*?<\/function_calls>/gs, '')
    .replace(/<invoke[^>]*>.*?<\/invoke>/gs, '')
    .replace(/<parameter[^>]*>.*?<\/parameter>/gs, '')
    .replace(/```xml[\s\S]*?```/g, '')
    .trim();
}

// ── Helpers: convert DB messages → Claude API format ───────────────────────

type ClaudeMessage = Anthropic.Messages.MessageParam;
type ContentBlock =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ToolUseBlockParam
  | Anthropic.Messages.ToolResultBlockParam;

/** Max chars to keep for a historical tool result in the message window.
 *  Claude already consumed the full payload in the round it was received;
 *  subsequent rounds only need enough context to follow the conversation. */
const TOOL_RESULT_HISTORY_LIMIT = 2000;

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(messages: ClaudeMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Drop oldest messages (keeping the first as context anchor) until the
 *  estimated token count falls below budget. */
function trimToBudget(messages: ClaudeMessage[], budget: number): ClaudeMessage[] {
  while (messages.length > 2 && estimateTokens(messages) > budget) {
    messages.splice(1, 1);
  }
  return messages;
}

export function dbMessagesToClaudeMessages(dbMsgs: DbMessage[]): ClaudeMessage[] {
  const claude: ClaudeMessage[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let currentContent: ContentBlock[] = [];

  function flush() {
    if (currentRole && currentContent.length > 0) {
      claude.push({ role: currentRole, content: currentContent });
      currentContent = [];
    }
  }

  for (const msg of dbMsgs) {
    if (msg.role === "user") {
      flush();
      currentRole = "user";
      currentContent = [{ type: "text", text: msg.content }];
    } else if (msg.role === "assistant") {
      flush();
      currentRole = "assistant";
      currentContent = [{ type: "text", text: msg.content }];
    } else if (msg.role === "tool_use") {
      // tool_use blocks belong to assistant turns
      if (currentRole !== "assistant") {
        flush();
        currentRole = "assistant";
        currentContent = [];
      }
      currentContent.push({
        type: "tool_use",
        id: msg.toolUseId!,
        name: msg.toolName!,
        input: msg.toolInput ?? {},
      });
    } else if (msg.role === "tool_result") {
      // tool_result blocks belong to user turns
      if (currentRole !== "user") {
        flush();
        currentRole = "user";
        currentContent = [];
      }
      // Truncate historical tool results — full payloads are the primary cause
      // of context window overflows. Claude already used the full data in the
      // round it was received; history only needs enough to follow the thread.
      const content = msg.content.length > TOOL_RESULT_HISTORY_LIMIT
        ? msg.content.slice(0, TOOL_RESULT_HISTORY_LIMIT) + "\n…[truncated]"
        : msg.content;
      currentContent.push({
        type: "tool_result",
        tool_use_id: msg.toolUseId!,
        content,
      });
    }
  }
  flush();

  // Safety net: drop oldest messages if still over the token budget,
  // leaving 20k headroom for the response + system prompt + tools.
  return trimToBudget(claude, 180_000);
}

// ── SSE Stream event types ────────────────────────────────────────────────

export type StreamEvent =
  | { event: "text_delta"; data: { text: string } }
  | { event: "tool_start"; data: { name: string; id: string } }
  | { event: "tool_end"; data: { name: string; id: string } }
  | { event: "done"; data: { assistantText: string } }
  | { event: "error"; data: { message: string } };

// ── Main chat function ─────────────────────────────────────────────────────

export interface ChatResult {
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
}

export async function chat(
  sessionId: string,
  userMessage: string,
  userEmail?: string,
  vertical?: Vertical
): Promise<ChatResult> {
  const client = getClient();
  // Always show ALL tools to Claude — ACL enforcement happens before each tool call
  const tools = getToolsForClaude();

  // ── Response cache check ──────────────────────────────────────────────
  const cacheKey = responseCacheKey(userMessage, vertical);
  const cached = await responseCache.get(cacheKey);
  if (cached) {
    logInfo(`Response cache hit: ${cacheKey}`);
    let cachedText = cached.assistantText;
    if (DEBUG_MODE) {
      cachedText += formatDebugMarkdown([], true, cacheKey);
    }
    // Persist messages to MongoDB so conversation history stays intact
    await appendMessage(sessionId, { role: "user", content: userMessage });
    await appendMessage(sessionId, { role: "assistant", content: cachedText });
    // Auto-generate title for new sessions
    const dbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
    if (dbMsgs.length <= 2) {
      const titleSnippet = userMessage.length > 60 ? userMessage.slice(0, 57) + "..." : userMessage;
      await updateSessionTitle(sessionId, titleSnippet);
    }
    return { assistantText: cachedText, toolCalls: cached.toolCalls };
  }

  // 1. Persist user message
  await appendMessage(sessionId, { role: "user", content: userMessage });

  // 2. Load windowed history from DB (most recent N messages)
  const dbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
  let claudeMessages = dbMessagesToClaudeMessages(dbMsgs);

  const toolCalls: ChatResult["toolCalls"] = [];
  const debugEntries: DebugEntry[] = [];
  let finalText = "";
  let toolCallErrored = false;

  // 3. Agentic loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await claudeCircuitBreaker.execute(() =>
      withClaudeSpan(
        {
          model: getModel(),
          sessionId,
          round,
          toolCount: tools.length,
        },
        async (span) => {
          const resp = await client.messages.create({
            model: getModel(),
            max_tokens: 8192,
            system: buildSystemPrompt(),
            tools,
            messages: claudeMessages,
          });
          span.setAttribute("llm.stop_reason", resp.stop_reason || "unknown");
          span.setAttribute("llm.usage.input_tokens", resp.usage?.input_tokens || 0);
          span.setAttribute("llm.usage.output_tokens", resp.usage?.output_tokens || 0);
          return resp;
        }
      )
    );

    // Collect text + tool_use blocks from response
    const textBlocks: string[] = [];
    const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    // Persist assistant text (if any), sanitized to remove technical markup
    const rawAssistantText = textBlocks.join("\n");
    const assistantText = sanitizeAssistantText(rawAssistantText);
    if (assistantText) {
      await appendMessage(sessionId, {
        role: "assistant",
        content: assistantText,
      });
    }

    // Persist tool_use blocks
    for (const tu of toolUseBlocks) {
      await appendMessage(sessionId, {
        role: "tool_use",
        content: "",
        toolName: tu.name,
        toolInput: tu.input as Record<string, unknown>,
        toolUseId: tu.id,
      });
    }

    // If stop_reason is "end_turn" (no tool calls), we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      finalText = assistantText; // Already sanitized above
      break;
    }

    // 4. Execute each tool call via MCP and collect results
    for (const tu of toolUseBlocks) {
      let resultText: string;

      // ── ACL check before calling the tool ──────────────────────────────
      const aclResult = await checkUserToolAccess(tu.name, userEmail);
      if (!aclResult.allowed) {
        resultText = aclResult.reason;
      } else {
        try {
          // Inject vertical parameter for sales funnel tools if vertical is provided
          const toolInput = tu.input as Record<string, unknown>;
          const isSalesFunnelTool = [
            'get_sales_funnel',
            'get_leads',
            'get_prospects',
            'get_accounts',
            'get_sales'
          ].includes(tu.name);

          let finalInput = { ...toolInput };

          // 1. Resolve locations if present (Client-Side Resolution)
          if (finalInput.locations && Array.isArray(finalInput.locations)) {
            const rawLocations = finalInput.locations as string[];
            const canonicalLocations = resolveLocations(rawLocations);
            finalInput.locations = canonicalLocations;
            logInfo(`Resolved locations: ${JSON.stringify(rawLocations)} -> ${JSON.stringify(canonicalLocations)}`);
          }

          // 2. Inject vertical if needed — only if Claude didn't already specify one
          if (vertical && isSalesFunnelTool && !finalInput.vertical) {
            finalInput = { ...finalInput, vertical };
          }

          resultText = await callTool(
            tu.name,
            finalInput,
            userEmail
          );
        } catch (err) {
          logError(`Tool call "${tu.name}" failed`, err instanceof Error ? err : new Error(String(err)), {
            sessionId,
            tool: tu.name,
          });
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
          toolCallErrored = true;
        }
      }

      toolCalls.push({
        name: tu.name,
        input: tu.input as Record<string, unknown>,
        result: resultText,
      });

      // Extract debug info from tool result if DEBUG_MODE is on
      if (DEBUG_MODE) {
        const debugEntry = extractDebugFromResult(resultText, tu.name, tu.input as Record<string, unknown>);
        if (debugEntry) debugEntries.push(debugEntry);
      }

      // Persist tool_result
      await appendMessage(sessionId, {
        role: "tool_result",
        content: resultText,
        toolUseId: tu.id,
      });
    }

    // 5. Reload windowed messages for next Claude call
    const updatedDbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
    claudeMessages = dbMessagesToClaudeMessages(updatedDbMsgs);
  }

  // Auto-generate a title for new sessions (first user message)
  if (dbMsgs.length <= 1) {
    const titleSnippet =
      userMessage.length > 60
        ? userMessage.slice(0, 57) + "..."
        : userMessage;
    await updateSessionTitle(sessionId, titleSnippet);
  }

  // ── Append debug info to response if DEBUG_MODE is on ──────────────────
  if (DEBUG_MODE && debugEntries.length > 0) {
    finalText += formatDebugMarkdown(debugEntries);
  }

  // ── Cache the response for future identical questions ─────────────────
  // Only cache if tools were called successfully — skip caching when no tool calls
  // happened (likely a fallback) or when any tool call errored (e.g. MCP timeout).
  const result: ChatResult = { assistantText: finalText, toolCalls };
  if (finalText && toolCalls.length > 0 && !toolCallErrored) {
    const ttl = detectResponseTTL(userMessage);
    await responseCache.set(cacheKey, result, ttl);
    logInfo(`Response cached (TTL ${ttl}s): ${cacheKey}`);
  }

  return result;
}

// ── Streaming chat function ───────────────────────────────────────────────

export async function* chatStream(
  sessionId: string,
  userMessage: string,
  userEmail?: string,
  vertical?: Vertical
): AsyncGenerator<StreamEvent> {
  const client = getClient();
  // Always show ALL tools to Claude — ACL enforcement happens before each tool call
  const tools = getToolsForClaude();

  // ── Response cache check ──────────────────────────────────────────────
  const cacheKey = responseCacheKey(userMessage, vertical);
  const cached = await responseCache.get(cacheKey);
  if (cached) {
    logInfo(`Response cache hit (stream): ${cacheKey}`);
    let cachedText = cached.assistantText;
    if (DEBUG_MODE) {
      cachedText += formatDebugMarkdown([], true, cacheKey);
    }
    await appendMessage(sessionId, { role: "user", content: userMessage });
    await appendMessage(sessionId, { role: "assistant", content: cachedText });
    const dbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
    if (dbMsgs.length <= 2) {
      const titleSnippet = userMessage.length > 60 ? userMessage.slice(0, 57) + "..." : userMessage;
      await updateSessionTitle(sessionId, titleSnippet);
    }
    yield { event: "text_delta" as const, data: { text: cachedText } };
    yield { event: "done" as const, data: { assistantText: cachedText } };
    return;
  }

  // 1. Persist user message
  await appendMessage(sessionId, { role: "user", content: userMessage });

  // 2. Load windowed history from DB
  const dbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
  let claudeMessages = dbMessagesToClaudeMessages(dbMsgs);

  let finalText = "";
  let toolCallCount = 0;
  let toolCallErrored = false;
  const debugEntries: DebugEntry[] = [];

  // 3. Agentic loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Use raw streaming API (async iterable) so we can yield from the generator
    const stream = await claudeCircuitBreaker.execute(() =>
      client.messages.create({
        model: getModel(),
        max_tokens: 8192,
        system: buildSystemPrompt(),
        tools,
        messages: claudeMessages,
        stream: true,
      })
    );

    const textParts: string[] = [];
    const toolUseBlocks: { id: string; name: string; inputJson: string }[] = [];
    let currentToolIndex = -1;
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          currentToolIndex = toolUseBlocks.length;
          toolUseBlocks.push({
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          textParts.push(event.delta.text);
          yield { event: "text_delta" as const, data: { text: event.delta.text } };
        } else if (event.delta.type === "input_json_delta" && currentToolIndex >= 0) {
          toolUseBlocks[currentToolIndex].inputJson += event.delta.partial_json;
        }
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason;
      }
    }

    // Persist assistant text
    const rawAssistantText = textParts.join("");
    const assistantText = sanitizeAssistantText(rawAssistantText);
    if (assistantText) {
      await appendMessage(sessionId, { role: "assistant", content: assistantText });
    }

    // Parse and persist tool_use blocks
    const parsedToolBlocks: Anthropic.Messages.ToolUseBlock[] = [];
    for (const tu of toolUseBlocks) {
      let input: Record<string, unknown> = {};
      try {
        input = tu.inputJson ? JSON.parse(tu.inputJson) : {};
      } catch {
        input = {};
      }
      parsedToolBlocks.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input,
      });
      await appendMessage(sessionId, {
        role: "tool_use",
        content: "",
        toolName: tu.name,
        toolInput: input,
        toolUseId: tu.id,
      });
    }

    // If no tool calls, we're done
    if (stopReason === "end_turn" || parsedToolBlocks.length === 0) {
      finalText = assistantText;
      break;
    }

    // 4. Execute tool calls
    for (const tu of parsedToolBlocks) {
      toolCallCount++;
      logInfo(`Tool call: ${tu.name}`, { tool: tu.name, input: tu.input });
      yield { event: "tool_start" as const, data: { name: tu.name, id: tu.id } };

      let resultText: string;

      // ── ACL check before calling the tool ──────────────────────────────
      const aclResult = await checkUserToolAccess(tu.name, userEmail);
      if (!aclResult.allowed) {
        resultText = aclResult.reason;
      } else {
        try {
          const toolInput = tu.input as Record<string, unknown>;
          const isSalesFunnelTool = [
            'get_sales_funnel',
            'get_leads',
            'get_prospects',
            'get_accounts',
            'get_sales'
          ].includes(tu.name);

          let finalInput = { ...toolInput };

          // Resolve locations if present (Client-Side Resolution)
          if (finalInput.locations && Array.isArray(finalInput.locations)) {
            const rawLocations = finalInput.locations as string[];
            const canonicalLocations = resolveLocations(rawLocations);
            finalInput.locations = canonicalLocations;
            logInfo(`Resolved locations: ${JSON.stringify(rawLocations)} -> ${JSON.stringify(canonicalLocations)}`);
          }

          // Inject vertical if needed — only if Claude didn't already specify one
          if (vertical && isSalesFunnelTool && !finalInput.vertical) {
            finalInput = { ...finalInput, vertical };
          }

          resultText = await callTool(
            tu.name,
            finalInput,
            userEmail
          );
        } catch (err) {
          logError(`Tool call "${tu.name}" failed`, err instanceof Error ? err : new Error(String(err)), {
            sessionId,
            tool: tu.name,
          });
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
          toolCallErrored = true;
        }
      }

      // Extract debug info from tool result if DEBUG_MODE is on
      if (DEBUG_MODE) {
        const debugEntry = extractDebugFromResult(resultText, tu.name, tu.input as Record<string, unknown>);
        if (debugEntry) debugEntries.push(debugEntry);
      }

      await appendMessage(sessionId, {
        role: "tool_result",
        content: resultText,
        toolUseId: tu.id,
      });

      yield { event: "tool_end" as const, data: { name: tu.name, id: tu.id } };
    }

    // 5. Reload messages for next round
    const updatedDbMsgs = await getMessages(sessionId, MESSAGE_WINDOW_SIZE);
    claudeMessages = dbMessagesToClaudeMessages(updatedDbMsgs);
  }

  // Auto-generate title for new sessions
  if (dbMsgs.length <= 1) {
    const titleSnippet =
      userMessage.length > 60 ? userMessage.slice(0, 57) + "..." : userMessage;
    await updateSessionTitle(sessionId, titleSnippet);
  }

  // ── Append debug info to response if DEBUG_MODE is on ──────────────────
  if (DEBUG_MODE && debugEntries.length > 0) {
    const debugMd = formatDebugMarkdown(debugEntries);
    finalText += debugMd;
    yield { event: "text_delta" as const, data: { text: debugMd } };
  }

  // ── Cache the response for future identical questions ─────────────────
  // Only cache if tools were called successfully — skip caching when no tool calls
  // happened (likely a fallback) or when any tool call errored (e.g. MCP timeout).
  if (finalText && toolCallCount > 0 && !toolCallErrored) {
    const ttl = detectResponseTTL(userMessage);
    await responseCache.set(cacheKey, { assistantText: finalText, toolCalls: [] }, ttl);
    logInfo(`Response cached (stream, TTL ${ttl}s): ${cacheKey}`);
  }

  yield { event: "done" as const, data: { assistantText: finalText } };
}
