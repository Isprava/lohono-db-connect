import { z } from "zod";
import { logger } from "../../../shared/observability/src/logger.js";
import { checkToolAccess } from "../acl.js";
import { pool } from "../db/pool.js";
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

/** Dispatch a tool call to the correct plugin handler (with ACL check) */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  userEmail?: string
): Promise<ToolResult> {
  try {
    // ACL enforcement
    const aclResult = await checkToolAccess(name, userEmail, pool);
    if (!aclResult.allowed) {
      return {
        content: [{ type: "text", text: `Access denied: ${aclResult.reason}` }],
        isError: true,
      };
    }

    const plugin = plugins.get(name);
    if (!plugin) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return await plugin.handler(args, userEmail);
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
    logger.error(`Tool "${name}" failed`, { error: message, tool: name, userEmail });
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
