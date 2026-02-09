import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, handleToolCall, pool } from "./tools.js";
import { resolveUserEmail, filterToolsByAccess, loadAclConfig } from "./acl.js";

// Load ACL config at startup
loadAclConfig();

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

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const meta = request.params?._meta as Record<string, unknown> | undefined;
  const userEmail = resolveUserEmail(meta);
  const tools = await filterToolsByAccess(toolDefinitions, userEmail, pool);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params;
  const meta = _meta as Record<string, unknown> | undefined;
  const userEmail = resolveUserEmail(meta);
  return handleToolCall(name, args, userEmail);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
