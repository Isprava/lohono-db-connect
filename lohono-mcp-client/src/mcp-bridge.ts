import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type Anthropic from "@anthropic-ai/sdk";
import { withMCPToolSpan, logInfo, logError } from "../../shared/observability/src/index.js";
import { RedisCache } from "../../shared/redis/src/index.js";
import { CircuitBreaker, type CircuitState } from "../../shared/circuit-breaker/src/index.js";

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
  /** Whether a reconnection attempt is in progress */
  reconnecting: boolean;
}

// ── Reconnection constants ───────────────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 1000;   // 1s initial delay
const RECONNECT_MAX_DELAY_MS = 60_000;  // 60s max delay
const RECONNECT_MAX_ATTEMPTS = 10;

// ── Multi-Server Registry ─────────────────────────────────────────────────

const servers = new Map<string, MCPServerConnection>();
const toolToServer = new Map<string, string>(); // tool name → server ID
/** Original configs for reconnection */
let serverConfigs: MCPServerConfig[] = [];
/** Per-server circuit breakers */
const serverCircuitBreakers = new Map<string, CircuitBreaker>();

function getServerCircuitBreaker(serverId: string): CircuitBreaker {
  let cb = serverCircuitBreakers.get(serverId);
  if (!cb) {
    cb = new CircuitBreaker({ name: `mcp-${serverId}`, failureThreshold: 5, resetTimeoutMs: 30_000 });
    serverCircuitBreakers.set(serverId, cb);
  }
  return cb;
}

/** Get circuit breaker states for all MCP servers (for health checks) */
export function getMcpCircuitStates(): Record<string, CircuitState> {
  const states: Record<string, CircuitState> = {};
  for (const [id, cb] of serverCircuitBreakers) {
    states[id] = cb.getState();
  }
  return states;
}

/**
 * Connect to a single MCP server. Returns the connection or null on failure.
 */
async function connectSingleServer(config: MCPServerConfig): Promise<MCPServerConnection | null> {
  try {
    const client = new Client(
      { name: `lohono-mcp-client-${config.id}`, version: "1.0.0" },
      { capabilities: {} }
    );

    const transport = new SSEClientTransport(new URL(`${config.sseUrl}/sse`));
    await client.connect(transport);

    const result = await client.listTools();
    const tools = result.tools as MCPTool[];

    const conn: MCPServerConnection = {
      id: config.id,
      client,
      sseUrl: config.sseUrl,
      tools,
      reconnecting: false,
    };

    // Register tools
    for (const tool of tools) {
      toolToServer.set(tool.name, config.id);
    }

    logInfo(`MCP server connected: ${config.id}`, {
      mcp_url: config.sseUrl,
      tool_count: String(tools.length),
    });

    return conn;
  } catch (err) {
    logError(
      `Failed to connect MCP server: ${config.id}`,
      err instanceof Error ? err : new Error(String(err)),
      { mcp_url: config.sseUrl }
    );
    return null;
  }
}

/**
 * Reconnect a single MCP server with exponential backoff.
 * Runs in the background — does not block callers.
 */
async function reconnectServer(config: MCPServerConfig): Promise<void> {
  const existing = servers.get(config.id);
  if (existing?.reconnecting) return; // already reconnecting

  if (existing) {
    existing.reconnecting = true;
  }

  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RECONNECT_MAX_DELAY_MS
    );

    logInfo(`Reconnecting MCP server ${config.id} (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS}) in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const conn = await connectSingleServer(config);
    if (conn) {
      servers.set(config.id, conn);
      return;
    }
  }

  logError(
    `MCP server ${config.id}: reconnection failed after ${RECONNECT_MAX_ATTEMPTS} attempts`,
    new Error("Max reconnection attempts reached"),
    { mcp_url: config.sseUrl }
  );

  // Mark as no longer reconnecting so a future call can retry
  const server = servers.get(config.id);
  if (server) server.reconnecting = false;
}

export async function connectMCP(configs: MCPServerConfig[]): Promise<void> {
  serverConfigs = configs;

  for (const config of configs) {
    const conn = await connectSingleServer(config);
    if (conn) {
      servers.set(config.id, conn);
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
  const cached = await userToolsCache.get(userEmail);
  if (cached) {
    return cached;
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

  await userToolsCache.set(userEmail, allTools);
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

const userToolsCache = new RedisCache<ClaudeTool[]>("tools:user", 5 * 60); // 5 minutes

/**
 * Invoke a tool on the appropriate MCP server and return the text result.
 * Routes to the correct server based on tool name.
 * On connection failure, triggers background reconnection.
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

  const circuitBreaker = getServerCircuitBreaker(serverId);

  try {
    return await circuitBreaker.execute(() =>
      withMCPToolSpan(
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
      )
    );
  } catch (err) {
    // If the call failed due to a connection issue, trigger background reconnection
    const config = serverConfigs.find((c) => c.id === serverId);
    if (config && !server.reconnecting) {
      logInfo(`Tool call failed for ${name}, triggering reconnection for server ${serverId}`);
      reconnectServer(config).catch(() => {}); // fire-and-forget
    }
    throw err;
  }
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

/** Return all registered MCP tool names (for admin UI) */
export function getToolNames(): string[] {
  return Array.from(toolToServer.keys()).sort();
}

export async function disconnectMCP(): Promise<void> {
  for (const server of servers.values()) {
    try {
      await server.client.close();
    } catch (err) {
      logError(`MCP server close error: ${server.id}`, err instanceof Error ? err : new Error(String(err)));
    }
  }
  servers.clear();
  toolToServer.clear();
}
