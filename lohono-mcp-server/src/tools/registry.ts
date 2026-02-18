import { z } from "zod";
import { logger } from "../../../shared/observability/src/logger.js";
import type { ToolPlugin, ToolResult, ToolDefinition } from "./types.js";

// ── Plugin registry ─────────────────────────────────────────────────────────

const plugins = new Map<string, ToolPlugin>();

/** Register one or more tool plugins */
export function registerPlugins(...pluginList: ToolPlugin[]): void {
  for (const plugin of pluginList) {
    if (plugins.has(plugin.definition.name)) {
      logger.warn(`Overwriting existing tool plugin: ${plugin.definition.name}`);
    }
    plugins.set(plugin.definition.name, plugin);
  }
  logger.info(`Registered ${pluginList.length} tool plugin(s)`, {
    tools: pluginList.map((p) => p.definition.name).join(", "),
  });
}

/** Get all registered tool definitions (for MCP ListTools) */
export function getToolDefinitions(): ToolDefinition[] {
  return [...plugins.values()].map((p) => p.definition);
}

/** Dispatch a tool call to the correct plugin handler. ACL enforcement happens on the MCP Client side. */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  try {
    const plugin = plugins.get(name);
    if (!plugin) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return await plugin.handler(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [{
          type: "text",
          text: `Validation error: ${error.issues.map((e) => e.message).join(", ")}`,
        }],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Tool "${name}" failed`, { error: message, tool: name });
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
