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

/** Build a cache key from the user message and vertical. */
function responseCacheKey(userMessage: string, vertical?: Vertical): string {
  return `${normalizeQuestion(userMessage)}:${vertical || DEFAULT_VERTICAL}`;
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

**Vertical Resolution:**
- When the user mentions "Chapter" or "chapter" (without "The"), always treat it as the \`the_chapter\` vertical.
- When the user mentions "Lohono" or "lohono" (without "Stays"), always treat it as the \`lohono_stays\` vertical.
- Always pass the canonical vertical value (\`the_chapter\`, \`lohono_stays\`, \`isprava\`, \`solene\`) to tool calls.

**Query Process:**
1. For sales funnel metrics (Leads, Prospects, Accounts, Sales), ALWAYS use the get_sales_funnel tool
2. For schema exploration, use catalog tools (get_tables_summary, search_tables, get_table_schema, etc.)
3. For questions about policies, procedures, SOPs, villa information, guest guidelines, operational documentation, or Goa building/construction regulations (DCR norms, FAR/FSI, setbacks, zoning, parking, fire safety, building heights, plot coverage, sub-division rules, land development regulations), use the query_knowledge_base tool
4. If a question is ambiguous, prefer data tools for metrics/numbers and the knowledge base for qualitative/procedural/regulatory questions
5. If the knowledge base tool returns an error (e.g., access error, permission denied), tell the user clearly that the knowledge base is temporarily unavailable and suggest they contact their team for the information directly. Do NOT say "I wasn't able to find information" — be specific about the issue.
6. Present results to users in a clear, professional format

**IMPORTANT - User-Facing Responses:**
- NEVER show query execution plans or technical query analysis details to users
- NEVER show sales funnel context rules, business logic, or internal configuration in responses
- NEVER expose database schema details, table structures, or technical metadata
- NEVER include <function_calls>, <invoke>, or any XML/technical markup in your text responses
- NEVER mention tool names, tool calls, or explain what tools you're using
- DO show: the SQL query used in a code block (\`\`\`sql\n...\n\`\`\`) when presenting query results
- DO show: clean data results, insights, trends, summaries, and clear answers to their questions
- DO format: results as tables, bullet points, or summaries as appropriate
- DO speak naturally as if you directly accessed the data

**SQL Query Display:**
When you execute a SQL query and present results, ALWAYS include the SQL query used in a markdown code block like this:
\`\`\`sql
SELECT * FROM table WHERE condition;
\`\`\`

The user wants business insights, not technical details. Keep responses focused on answering their question with data. Show the SQL query for transparency, but don't explain tool internals.`;
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
      currentContent.push({
        type: "tool_result",
        tool_use_id: msg.toolUseId!,
        content: msg.content,
      });
    }
  }
  flush();

  return claude;
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
            system: SYSTEM_PROMPT,
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

          // 2. Inject vertical if needed
          if (vertical && isSalesFunnelTool) {
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
  // Only cache if tools were actually called — a response with no tool calls
  // is likely a fallback/error (e.g. MCP bridge timeout) and should not be cached.
  const result: ChatResult = { assistantText: finalText, toolCalls };
  if (finalText && toolCalls.length > 0) {
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
  const debugEntries: DebugEntry[] = [];

  // 3. Agentic loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Use raw streaming API (async iterable) so we can yield from the generator
    const stream = await claudeCircuitBreaker.execute(() =>
      client.messages.create({
        model: getModel(),
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
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

          // Inject vertical if needed
          if (vertical && isSalesFunnelTool) {
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
  // Only cache if tools were actually called — a response with no tool calls
  // is likely a fallback/error (e.g. MCP bridge timeout) and should not be cached.
  if (finalText && toolCallCount > 0) {
    const ttl = detectResponseTTL(userMessage);
    await responseCache.set(cacheKey, { assistantText: finalText, toolCalls: [] }, ttl);
    logInfo(`Response cached (stream, TTL ${ttl}s): ${cacheKey}`);
  }

  yield { event: "done" as const, data: { assistantText: finalText } };
}
