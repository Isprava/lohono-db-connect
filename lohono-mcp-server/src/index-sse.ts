// ── OTel SDK must be imported FIRST ────────────────────────────────────────
import "../../shared/observability/src/tracing.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import { toolDefinitions, handleToolCall, pool } from "./tools.js";
import { getDbCircuitState } from "./db/pool.js";
import {
  requestLoggingMiddleware,
  errorLoggingMiddleware,
  logInfo,
  logError,
  withMCPServerToolSpan,
  startSSESessionSpan,
} from "../../shared/observability/src/index.js";

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLoggingMiddleware());

// ── Session storage ──
const sessionTransports = new Map<string, SSEServerTransport>();

// Create MCP server
const server = new Server(
  {
    name: "lohono-db-context",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Return all tool definitions — ACL enforcement happens on the MCP Client side
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

// Execute tool directly — ACL enforcement happens on the MCP Client side
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  return withMCPServerToolSpan(
    { toolName: name, toolArgs: (args || {}) as Record<string, unknown> },
    async () => handleToolCall(name, args)
  );
});

// SSE endpoint
app.get("/sse", async (req, res) => {
  const headerEmail = req.headers["x-user-email"] as string | undefined;
  logInfo(`New SSE connection established`, { user_email: headerEmail });

  const sseSpan = startSSESessionSpan(headerEmail);
  const transport = new SSEServerTransport("/messages", res);

  sessionTransports.set(transport.sessionId, transport);

  await server.connect(transport);

  req.on("close", () => {
    logInfo("SSE connection closed", { user_email: headerEmail });
    sseSpan.end();
    sessionTransports.delete(transport.sessionId);
  });
});

// POST endpoint for client messages
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sessionTransports.get(sessionId);
  if (!transport) {
    logError("No active SSE session for sessionId", undefined, { sessionId });
    res.status(400).json({ error: "No active SSE session for this sessionId" });
    return;
  }
  logInfo("Received SSE message", { sessionId, message_type: typeof req.body });
  await transport.handlePostMessage(req, res, req.body);
});

// Health check endpoint
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", server: "lohono-db-context", db: "connected", circuits: { postgresql: getDbCircuitState() } });
  } catch (err) {
    logError("Health check: DB unreachable", err instanceof Error ? err : new Error(String(err)));
    res.status(503).json({ status: "error", server: "lohono-db-context", db: "disconnected", circuits: { postgresql: getDbCircuitState() } });
  }
});

// Error logging middleware (must be last)
app.use(errorLoggingMiddleware());

// Graceful shutdown
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logInfo(`MCP SSE server running`, {
    port: PORT as unknown as string,
    sse_endpoint: `http://localhost:${PORT}/sse`,
    health_endpoint: `http://localhost:${PORT}/health`,
  });
});
