import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type Anthropic from "@anthropic-ai/sdk";
import { withMCPToolSpan, logInfo, logError } from "../../shared/observability/src/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ClaudeTool = Anthropic.Messages.Tool;

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

// ── MCP Bridge ─────────────────────────────────────────────────────────────

let mcpClient: Client;
let cachedTools: MCPTool[] = [];

export async function connectMCP(sseUrl: string): Promise<void> {
  mcpClient = new Client(
    { name: "lohono-mcp-client", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new SSEClientTransport(new URL(`${sseUrl}/sse`));
  await mcpClient.connect(transport);

  // Discover and cache tools
  const result = await mcpClient.listTools();
  cachedTools = result.tools as MCPTool[];
  logInfo(`MCP connected`, {
    mcp_url: sseUrl,
    tool_count: String(cachedTools.length),
  });
}

/**
 * Returns MCP tool definitions formatted for the Claude Messages API.
 * Falls back to startup cache if no user email provided.
 */
export function getToolsForClaude(): ClaudeTool[] {
  return cachedTools.map(toClaudeTool);
}

/**
 * Fetch tools the user has access to from the MCP server and return
 * them formatted for the Claude Messages API. Results are cached per user.
 */
export async function getToolsForUser(userEmail: string): Promise<ClaudeTool[]> {
  const cached = userToolsCache.get(userEmail);
  if (cached && Date.now() - cached.fetchedAt < USER_TOOLS_CACHE_TTL_MS) {
    return cached.tools;
  }

  const result = await mcpClient.listTools({
    _meta: { user_email: userEmail },
  } as Parameters<typeof mcpClient.listTools>[0]);

  const tools = (result.tools as MCPTool[]).map(toClaudeTool);
  userToolsCache.set(userEmail, { tools, fetchedAt: Date.now() });
  return tools;
}

function toClaudeTool(t: MCPTool): ClaudeTool {
  return {
    name: t.name,
    description: t.description || "",
    input_schema: {
      type: t.inputSchema.type as "object",
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  };
}

const USER_TOOLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const userToolsCache = new Map<string, { tools: ClaudeTool[]; fetchedAt: number }>();

/**
 * Invoke a tool on the MCP server and return the text result.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  userEmail?: string
): Promise<string> {
  return withMCPToolSpan(
    { toolName: name, toolArgs: args },
    async (span) => {
      const result = await mcpClient.callTool({
        name,
        arguments: args,
        _meta: userEmail ? { user_email: userEmail } : undefined,
      } as Parameters<typeof mcpClient.callTool>[0]);

      // MCP returns content as array of { type, text } blocks
      const textParts = (result.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text);

      const text = textParts.join("\n") || JSON.stringify(result.content);
      span.setAttribute("mcp.tool.result_length", text.length);
      return text;
    }
  );
}

/**
 * Refresh the cached tool list from the MCP server.
 */
export async function refreshTools(): Promise<void> {
  const result = await mcpClient.listTools();
  cachedTools = result.tools as MCPTool[];
}

export async function disconnectMCP(): Promise<void> {
  if (mcpClient) await mcpClient.close();
}
