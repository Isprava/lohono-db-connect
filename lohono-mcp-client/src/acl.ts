/**
 * Client-side ACL enforcement.
 * Checks whether a user has access to a tool before calling the MCP Server.
 */

import { getPgPool } from "./auth.js";
import { getGlobalAclConfig, getToolAclsMap } from "./db.js";
import { RedisCache } from "../../shared/redis/src/index.js";
import { logInfo, logError } from "../../shared/observability/src/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface CachedUser {
  acls: string[];
  active: boolean;
}

export interface AclCheckResult {
  allowed: boolean;
  reason: string;
}

// ── User ACL cache (from PostgreSQL staffs.acl_array) ────────────────────────

const userAclCache = new RedisCache<CachedUser>("client:acl:user", 5 * 60); // 5 min TTL

async function resolveUserAcls(email: string): Promise<CachedUser | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const cached = await userAclCache.get(normalizedEmail);
  if (cached) return cached;

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(
      `SELECT acl_array, active FROM public.staffs WHERE LOWER(email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    await client.query("COMMIT");

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as { acl_array: string[]; active: boolean };
    const user: CachedUser = { acls: row.acl_array || [], active: row.active ?? false };

    await userAclCache.set(normalizedEmail, user);
    return user;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logError(
      `ACL: Failed to resolve user ACLs for ${normalizedEmail}`,
      error instanceof Error ? error : new Error(String(error))
    );
    return null;
  } finally {
    client.release();
  }
}

// ── ACL config cache ─────────────────────────────────────────────────────────

interface AclConfig {
  default_policy: "open" | "deny";
  public_tools: string[];
  disabled_tools: string[];
  tool_acls: Record<string, string[]>;
}

let cachedConfig: AclConfig | null = null;
let configExpiresAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds

async function getAclConfig(): Promise<AclConfig> {
  const now = Date.now();
  if (cachedConfig && now < configExpiresAt) return cachedConfig;

  try {
    const [globalConfig, toolAcls] = await Promise.all([
      getGlobalAclConfig(),
      getToolAclsMap(),
    ]);

    cachedConfig = {
      default_policy: globalConfig.default_policy,
      public_tools: globalConfig.public_tools,
      disabled_tools: globalConfig.disabled_tools,
      tool_acls: toolAcls,
    };
    configExpiresAt = now + CONFIG_CACHE_TTL_MS;
    return cachedConfig;
  } catch (error) {
    logError(
      "ACL: Failed to load config from MongoDB",
      error instanceof Error ? error : new Error(String(error))
    );
    // Return permissive fallback if config can't be loaded
    return {
      default_policy: "open",
      public_tools: [],
      disabled_tools: [],
      tool_acls: {},
    };
  }
}

// ── Main ACL check ───────────────────────────────────────────────────────────

/**
 * Check whether a user has access to a specific tool.
 * Called by the agent before executing each tool call.
 */
export async function checkUserToolAccess(
  toolName: string,
  userEmail: string | undefined
): Promise<AclCheckResult> {
  const config = await getAclConfig();

  // 1. Disabled tool — blocked for everyone
  if (config.disabled_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is disabled.`,
    };
  }

  // 2. Public tool (without explicit tool_acls) — no auth needed
  if (config.public_tools.includes(toolName) && !config.tool_acls[toolName]) {
    return { allowed: true, reason: "Public tool" };
  }

  // 3. No email — authentication required
  if (!userEmail) {
    return {
      allowed: false,
      reason: "Authentication required to use this tool.",
    };
  }

  // 4. Resolve user ACLs from PostgreSQL
  const user = await resolveUserAcls(userEmail);

  if (!user) {
    return {
      allowed: false,
      reason: `User not found: ${userEmail}`,
    };
  }

  if (!user.active) {
    return {
      allowed: false,
      reason: `User account is deactivated: ${userEmail}`,
    };
  }

  // 5. Per-tool ACL check
  const requiredAcls = config.tool_acls[toolName];

  if (!requiredAcls || requiredAcls.length === 0) {
    // No ACL configured (or empty ACL list) for this tool — use default policy
    if (config.default_policy === "open") {
      return { allowed: true, reason: "Default policy: open" };
    }
    return {
      allowed: false,
      reason: `Access denied: tool "${toolName}" is not configured and default policy is deny.`,
    };
  }

  // OR logic — user needs at least one of the required ACLs
  const hasAccess = requiredAcls.some((required) => user.acls.includes(required));

  if (hasAccess) {
    return { allowed: true, reason: "ACL matched" };
  }

  logInfo(`ACL denied: ${userEmail} tried ${toolName}, needs [${requiredAcls.join(", ")}]`);

  return {
    allowed: false,
    reason: `Access denied: you do not have permission to use "${toolName}". Required ACL: [${requiredAcls.join(", ")}]. Please contact your administrator for access.`,
  };
}
