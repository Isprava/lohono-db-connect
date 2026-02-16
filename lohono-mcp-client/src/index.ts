// ── OTel SDK must be imported FIRST ────────────────────────────────────────
import "../../shared/observability/src/tracing.js";

import pg from "pg";
import { connectDB, disconnectDB } from "./db.js";
import { connectMCP, disconnectMCP, type MCPServerConfig } from "./mcp-bridge.js";
import { initPgPool } from "./auth.js";
import { app } from "./server.js";
import { logInfo, logError } from "../../shared/observability/src/index.js";

const { Pool } = pg;

// PostgreSQL pool for staff verification
const dbHost = process.env.DB_HOST || "localhost";
const pgPool = new Pool({
  host: dbHost,
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
  ssl:
    process.env.DB_SSL === "false" || dbHost === "localhost"
      ? false
      : { rejectUnauthorized: false },
});

async function main() {
  // 1. Connect to MongoDB
  await connectDB();

  // 2. Initialize PG pool for auth staff verification
  initPgPool(pgPool);

  // 3. Build MCP server configs
  const mcpServers: MCPServerConfig[] = [
    {
      id: "db-context",
      sseUrl: process.env.MCP_SSE_URL || "http://localhost:3000",
    },
  ];

  const helpdeskUrl = process.env.HELPDESK_SSE_URL;
  if (helpdeskUrl) {
    mcpServers.push({
      id: "helpdesk",
      sseUrl: helpdeskUrl,
    });
  }

  // 4. Connect to MCP servers (SSE)
  await connectMCP(mcpServers);

  // 5. Start Express REST API
  const port = parseInt(process.env.CLIENT_PORT || "3001", 10);
  app.listen(port, () => {
    logInfo(`MCP Client API running`, {
      port: String(port),
      mcp_servers: mcpServers.map((s) => s.id).join(", "),
      endpoints: "sessions, chat, health" as unknown as string,
    });
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await disconnectMCP();
  await disconnectDB();
  await pgPool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectMCP();
  await disconnectDB();
  await pgPool.end();
  process.exit(0);
});

main().catch((err) => {
  logError("Startup error", err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
