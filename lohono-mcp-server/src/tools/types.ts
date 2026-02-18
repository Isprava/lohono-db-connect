/** Standard MCP tool result — uses index signature for MCP SDK compatibility */
export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** MCP tool definition (JSON Schema for input) — uses index signature for MCP SDK compatibility */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  [key: string]: unknown;
}

/**
 * A self-contained tool plugin that bundles its definition and handler.
 * Each plugin is responsible for input validation (via Zod) and query execution.
 */
export interface ToolPlugin {
  /** MCP tool definition exposed to clients */
  definition: ToolDefinition;
  /** Execute the tool. Throw on validation errors; return ToolResult otherwise. */
  handler(args: Record<string, unknown> | undefined, userEmail?: string): Promise<ToolResult>;
}
