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
 */
export function getToolsForClaude(): ClaudeTool[] {
  return cachedTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: {
      type: t.inputSchema.type as "object",
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
}

/**
 * Invoke a tool on the MCP server and return the text result.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  return withMCPToolSpan(
    { toolName: name, toolArgs: args },
    async (span) => {
      const result = await mcpClient.callTool({ name, arguments: args });

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
