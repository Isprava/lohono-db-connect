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
import { toolDefinitions, handleToolCall } from "./tools.js";
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
const sessionEmails = new Map<SSEServerTransport, string>();
const sessionTransports = new Map<string, SSEServerTransport>();

// Create MCP server
const server = new Server(
  {
    name: "lohono-helpdesk",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

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

  if (headerEmail) {
    sessionEmails.set(transport, headerEmail);
  }
  sessionTransports.set(transport.sessionId, transport);

  await server.connect(transport);

  req.on("close", () => {
    logInfo("SSE connection closed", { user_email: headerEmail });
    sseSpan.end();
    sessionTransports.delete(transport.sessionId);
    sessionEmails.delete(transport);
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
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "lohono-helpdesk" });
});

// Error logging middleware (must be last)
app.use(errorLoggingMiddleware());

// Graceful shutdown
process.on("SIGINT", () => {
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  logInfo(`Helpdesk MCP SSE server running`, {
    port: PORT as unknown as string,
    sse_endpoint: `http://localhost:${PORT}/sse`,
    health_endpoint: `http://localhost:${PORT}/health`,
  });
});
