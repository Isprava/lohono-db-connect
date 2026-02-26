/**
 * Tool facade — re-exports from modular plugin system.
 *
 * This file exists for backward compatibility with index.ts and index-sse.ts.
 * All tool logic lives in tools/ plugins; the PG pool lives in db/pool.ts.
 */

export { pool } from "./db/pool.js";
export { getToolDefinitions as toolDefinitions_fn, handleToolCall } from "./tools/registry.js";

// ── Bootstrap: register all plugins at import time ──────────────────────────

import { registerPlugins } from "./tools/registry.js";
import { salesFunnelPlugins } from "./tools/sales-funnel.plugin.js";
import { predefinedQueryPlugins } from "./tools/predefined-query.plugin.js";

registerPlugins(...salesFunnelPlugins);
registerPlugins(...predefinedQueryPlugins);

// Re-export toolDefinitions as the array that index.ts and index-sse.ts expect
import { getToolDefinitions } from "./tools/registry.js";
export const toolDefinitions = getToolDefinitions();
