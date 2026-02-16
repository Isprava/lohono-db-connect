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

export interface MCPServerConfig {
  id: string;
  sseUrl: string;
}

interface MCPServerConnection {
  id: string;
  client: Client;
  sseUrl: string;
  tools: MCPTool[];
}

// ── Multi-Server Registry ─────────────────────────────────────────────────

const servers = new Map<string, MCPServerConnection>();
const toolToServer = new Map<string, string>(); // tool name → server ID

export async function connectMCP(configs: MCPServerConfig[]): Promise<void> {
  for (const config of configs) {
    try {
      const client = new Client(
        { name: `lohono-mcp-client-${config.id}`, version: "1.0.0" },
        { capabilities: {} }
      );

      const transport = new SSEClientTransport(new URL(`${config.sseUrl}/sse`));
      await client.connect(transport);

      const result = await client.listTools();
      const tools = result.tools as MCPTool[];

      servers.set(config.id, { id: config.id, client, sseUrl: config.sseUrl, tools });

      for (const tool of tools) {
        toolToServer.set(tool.name, config.id);
      }

      logInfo(`MCP server connected: ${config.id}`, {
        mcp_url: config.sseUrl,
        tool_count: String(tools.length),
      });
    } catch (err) {
      logError(
        `Failed to connect MCP server: ${config.id}`,
        err instanceof Error ? err : new Error(String(err)),
        { mcp_url: config.sseUrl }
      );
    }
  }

  if (servers.size === 0) {
    throw new Error("No MCP servers connected successfully");
  }
}

/**
 * Returns MCP tool definitions formatted for the Claude Messages API.
 * Aggregates tools from all connected servers.
 */
export function getToolsForClaude(): ClaudeTool[] {
  const allTools: ClaudeTool[] = [];
  for (const server of servers.values()) {
    allTools.push(...server.tools.map(toClaudeTool));
  }
  return allTools;
}

/**
 * Fetch tools the user has access to from all MCP servers and return
 * them formatted for the Claude Messages API. Results are cached per user.
 */
export async function getToolsForUser(userEmail: string): Promise<ClaudeTool[]> {
  const cached = userToolsCache.get(userEmail);
  if (cached && Date.now() - cached.fetchedAt < USER_TOOLS_CACHE_TTL_MS) {
    return cached.tools;
  }

  const allTools: ClaudeTool[] = [];
  for (const server of servers.values()) {
    try {
      const result = await server.client.listTools({
        _meta: { user_email: userEmail },
      } as Parameters<typeof server.client.listTools>[0]);
      allTools.push(...(result.tools as MCPTool[]).map(toClaudeTool));
    } catch (err) {
      logError(
        `Failed to list tools from server: ${server.id}`,
        err instanceof Error ? err : new Error(String(err))
      );
      // Fall back to cached tools for this server
      allTools.push(...server.tools.map(toClaudeTool));
    }
  }

  userToolsCache.set(userEmail, { tools: allTools, fetchedAt: Date.now() });
  return allTools;
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
 * Invoke a tool on the appropriate MCP server and return the text result.
 * Routes to the correct server based on tool name.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  userEmail?: string
): Promise<string> {
  const serverId = toolToServer.get(name);
  if (!serverId) {
    throw new Error(`No MCP server found for tool: ${name}`);
  }

  const server = servers.get(serverId);
  if (!server) {
    throw new Error(`MCP server not connected: ${serverId}`);
  }

  return withMCPToolSpan(
    { toolName: name, toolArgs: args },
    async (span) => {
      span.setAttribute("mcp.server.id", serverId);

      const result = await server.client.callTool({
        name,
        arguments: args,
        _meta: userEmail ? { user_email: userEmail } : undefined,
      } as Parameters<typeof server.client.callTool>[0]);

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
 * Refresh the cached tool list from all MCP servers.
 */
export async function refreshTools(): Promise<void> {
  toolToServer.clear();
  for (const server of servers.values()) {
    const result = await server.client.listTools();
    server.tools = result.tools as MCPTool[];
    for (const tool of server.tools) {
      toolToServer.set(tool.name, server.id);
    }
  }
}

export async function disconnectMCP(): Promise<void> {
  for (const server of servers.values()) {
    try {
      await server.client.close();
    } catch {
      // Ignore close errors during shutdown
    }
  }
  servers.clear();
  toolToServer.clear();
}
