import type pg from "pg";
import { getEffectiveAclConfig } from "./config.js";
import { resolveUserAcls } from "./user-cache.js";
import type { AclCheckResult } from "./types.js";

/**
 * Check whether a user (by email) can access a given tool.
 */
export async function checkToolAccess(
  toolName: string,
  userEmail: string | undefined,
  pool: pg.Pool
): Promise<AclCheckResult> {
  const config = await getEffectiveAclConfig();

  // 1. Disabled tool — blocked for everyone
  if (config.disabled_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is disabled. Use specialized tools instead (e.g., get_sales_funnel for sales metrics).`,
      user_email: userEmail,
    };
  }

  // 2. Public tool — no auth needed, UNLESS it has explicit tool_acls
  //    (tool_acls from YAML or Admin UI override public_tools status)
  if (config.public_tools.includes(toolName) && !config.tool_acls[toolName]) {
    return { allowed: true, reason: "Public tool", user_email: userEmail };
  }

  // 3. No email provided
  if (!userEmail) {
    return {
      allowed: false,
      reason:
        "Authentication required. Provide user email via _meta.user_email in tool call params, X-User-Email header, or MCP_USER_EMAIL env var.",
    };
  }

  // 4. Resolve user from DB
  const user = await resolveUserAcls(userEmail, pool);

  if (!user) {
    return {
      allowed: false,
      reason: `User not found: ${userEmail}`,
      user_email: userEmail,
    };
  }

  if (!user.active) {
    return {
      allowed: false,
      reason: `User account is deactivated: ${userEmail}`,
      user_email: userEmail,
      user_acls: user.acls,
    };
  }

  // 5. Per-tool ACL check
  const requiredAcls = config.tool_acls[toolName];

  if (!requiredAcls) {
    if (config.default_policy === "open") {
      return {
        allowed: true,
        reason: "Default policy: open (tool not in ACL config)",
        user_email: userEmail,
        user_acls: user.acls,
      };
    }
    return {
      allowed: false,
      reason: `Access denied: tool "${toolName}" is not configured in ACL and default policy is deny`,
      user_email: userEmail,
      user_acls: user.acls,
    };
  }

  // OR logic — user needs at least one of the required ACLs
  const hasAccess = requiredAcls.some((required) => user.acls.includes(required));

  if (hasAccess) {
    return {
      allowed: true,
      reason: "ACL matched",
      user_email: userEmail,
      user_acls: user.acls,
    };
  }

  return {
    allowed: false,
    reason: `Access denied: tool "${toolName}" requires one of [${requiredAcls.join(", ")}]. User has: [${user.acls.join(", ")}]`,
    user_email: userEmail,
    user_acls: user.acls,
  };
}

/**
 * Filter tool definitions to only include tools the user can access.
 * Used by ListTools to show only available tools.
 */
export async function filterToolsByAccess(
  tools: { name: string; [key: string]: unknown }[],
  userEmail: string | undefined,
  pool: pg.Pool
): Promise<{ name: string; [key: string]: unknown }[]> {
  const config = await getEffectiveAclConfig();

  // Filter out disabled tools first (no one can see them)
  const enabledTools = tools.filter((t) => !config.disabled_tools.includes(t.name));

  // No email — return all enabled tools for discovery.
  // ACL enforcement happens at CallTool time, so listing is permissive
  // to allow the MCP bridge to discover available tools.
  if (!userEmail) {
    return enabledTools;
  }

  // Resolve user
  const user = await resolveUserAcls(userEmail, pool);

  if (!user || !user.active) {
    return enabledTools.filter(
      (t) => config.public_tools.includes(t.name) && !config.tool_acls[t.name]
    );
  }

  // Filter per-tool
  return enabledTools.filter((t) => {
    const requiredAcls = config.tool_acls[t.name];

    // Public tool without explicit tool_acls — allow
    if (config.public_tools.includes(t.name) && !requiredAcls) return true;
    if (!requiredAcls) return config.default_policy === "open";

    return requiredAcls.some((required) => user.acls.includes(required));
  });
}
