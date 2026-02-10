import Anthropic from "@anthropic-ai/sdk";
import { getToolsForClaude, getToolsForUser, callTool } from "./mcp-bridge.js";
import {
  appendMessage,
  getMessages,
  updateSessionTitle,
  type Message as DbMessage,
} from "./db.js";
import { withClaudeSpan, withSpan, logInfo, logError } from "../../shared/observability/src/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 20; // safety limit to avoid infinite loops

const SYSTEM_PROMPT = `You are an expert data analyst assistant for Lohono Stays.
You have access to the Lohono production database through MCP tools.

**Query Process:**
1. For sales funnel metrics (Leads, Prospects, Accounts, Sales), ALWAYS use the get_sales_funnel tool
2. For schema exploration, use catalog tools (get_tables_summary, search_tables, get_table_schema, etc.)
3. Present results to users in a clear, professional format

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

// ── Claude client (singleton) ──────────────────────────────────────────────

let anthropic: Anthropic;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
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
function sanitizeAssistantText(text: string): string {
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

function dbMessagesToClaudeMessages(dbMsgs: DbMessage[]): ClaudeMessage[] {
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

// ── Main chat function ─────────────────────────────────────────────────────

export interface ChatResult {
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
}

export async function chat(
  sessionId: string,
  userMessage: string,
  userEmail?: string
): Promise<ChatResult> {
  const client = getClient();
  const tools = userEmail ? await getToolsForUser(userEmail) : getToolsForClaude();

  // 1. Persist user message
  await appendMessage(sessionId, { role: "user", content: userMessage });

  // 2. Load full history from DB
  const dbMsgs = await getMessages(sessionId);
  let claudeMessages = dbMessagesToClaudeMessages(dbMsgs);

  const toolCalls: ChatResult["toolCalls"] = [];
  let finalText = "";

  // 3. Agentic loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await withClaudeSpan(
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
      try {
        resultText = await callTool(
          tu.name,
          tu.input as Record<string, unknown>,
          userEmail
        );
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      toolCalls.push({
        name: tu.name,
        input: tu.input as Record<string, unknown>,
        result: resultText,
      });

      // Persist tool_result
      await appendMessage(sessionId, {
        role: "tool_result",
        content: resultText,
        toolUseId: tu.id,
      });
    }

    // 5. Reload messages for next Claude call
    const updatedDbMsgs = await getMessages(sessionId);
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

  return { assistantText: finalText, toolCalls };
}
