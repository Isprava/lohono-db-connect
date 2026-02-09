/**
 * ACL (Access Control List) Module
 *
 * Enforces per-tool access control by:
 *   1. Loading ACL config from YAML (tool → required ACLs)
 *   2. Resolving the user's ACLs from staffs.acl_array (by email)
 *   3. Checking whether the user's ACLs satisfy the tool's requirements
 *
 * User email is resolved in priority order:
 *   1. _meta.user_email in the MCP request params
 *   2. X-User-Email HTTP header (SSE mode)
 *   3. MCP_USER_EMAIL environment variable (stdio fallback)
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type pg from "pg";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AclConfig {
  default_policy: "open" | "deny";
  superuser_acls: string[];
  public_tools: string[];
  tool_acls: Record<string, string[]>;
}

export interface AclCheckResult {
  allowed: boolean;
  reason: string;
  user_email?: string;
  user_acls?: string[];
}

interface CachedUser {
  acls: string[];
  active: boolean;
  fetched_at: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_ACL_CONFIG_PATH = path.resolve(
  process.env.ACL_CONFIG_PATH || path.join(process.cwd(), "config", "acl.yml")
);

// ── State ──────────────────────────────────────────────────────────────────

let aclConfig: AclConfig | null = null;
const userCache = new Map<string, CachedUser>();

// ── Config loader ──────────────────────────────────────────────────────────

export function loadAclConfig(configPath?: string): AclConfig {
  if (aclConfig) return aclConfig;

  const filePath = configPath || DEFAULT_ACL_CONFIG_PATH;

  if (!fs.existsSync(filePath)) {
    console.error(`[ACL] Config not found at ${filePath} — defaulting to open policy`);
    aclConfig = {
      default_policy: "open",
      superuser_acls: [],
      public_tools: [],
      tool_acls: {},
    };
    return aclConfig;
  }

  const raw = yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;

  aclConfig = {
    default_policy: (raw.default_policy as "open" | "deny") || "deny",
    superuser_acls: (raw.superuser_acls as string[]) || [],
    public_tools: (raw.public_tools as string[]) || [],
    tool_acls: (raw.tool_acls as Record<string, string[]>) || {},
  };

  const toolCount = Object.keys(aclConfig.tool_acls).length;
  console.error(`[ACL] Loaded config: ${toolCount} tool rules, policy=${aclConfig.default_policy}`);

  return aclConfig;
}

/** Force reload (useful for testing or hot-reload) */
export function reloadAclConfig(configPath?: string): AclConfig {
  aclConfig = null;
  return loadAclConfig(configPath);
}

// ── User ACL resolver ──────────────────────────────────────────────────────

/**
 * Query staffs table for user's acl_array by email.
 * Results are cached for CACHE_TTL_MS.
 */
export async function resolveUserAcls(
  email: string,
  pool: pg.Pool
): Promise<{ acls: string[]; active: boolean } | null> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check cache
  const cached = userCache.get(normalizedEmail);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return { acls: cached.acls, active: cached.active };
  }

  // Query DB
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(
      `SELECT acl_array, active FROM public.staffs WHERE LOWER(email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    await client.query("COMMIT");

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as { acl_array: string[]; active: boolean };
    const acls = row.acl_array || [];
    const active = row.active ?? false;

    // Cache
    userCache.set(normalizedEmail, { acls, active, fetched_at: Date.now() });

    return { acls, active };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[ACL] DB error resolving ACLs for ${normalizedEmail}:`, error);
    return null;
  } finally {
    client.release();
  }
}

// ── Access check ───────────────────────────────────────────────────────────

/**
 * Check whether a user (by email) can access a given tool.
 */
export async function checkToolAccess(
  toolName: string,
  userEmail: string | undefined,
  pool: pg.Pool
): Promise<AclCheckResult> {
  const config = loadAclConfig();

  // 1. Public tool — no auth needed
  if (config.public_tools.includes(toolName)) {
    return { allowed: true, reason: "Public tool", user_email: userEmail };
  }

  // 2. No email provided
  if (!userEmail) {
    return {
      allowed: false,
      reason:
        "Authentication required. Provide user email via _meta.user_email in tool call params, X-User-Email header, or MCP_USER_EMAIL env var.",
    };
  }

  // 3. Resolve user from DB
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

  // 4. Superuser check
  const hasSuperuser = user.acls.some((a) => config.superuser_acls.includes(a));
  if (hasSuperuser) {
    return {
      allowed: true,
      reason: "Superuser access",
      user_email: userEmail,
      user_acls: user.acls,
    };
  }

  // 5. Per-tool ACL check
  const requiredAcls = config.tool_acls[toolName];

  if (!requiredAcls) {
    // Tool not in config — apply default policy
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

// ── Tool filtering ─────────────────────────────────────────────────────────

/**
 * Filter tool definitions to only include tools the user can access.
 * Used by ListTools to show only available tools.
 */
export async function filterToolsByAccess(
  tools: { name: string; [key: string]: unknown }[],
  userEmail: string | undefined,
  pool: pg.Pool
): Promise<{ name: string; [key: string]: unknown }[]> {
  const config = loadAclConfig();

  // No email — return only public tools
  if (!userEmail) {
    return tools.filter((t) => config.public_tools.includes(t.name));
  }

  // Resolve user
  const user = await resolveUserAcls(userEmail, pool);

  if (!user || !user.active) {
    return tools.filter((t) => config.public_tools.includes(t.name));
  }

  // Superuser — everything
  const hasSuperuser = user.acls.some((a) => config.superuser_acls.includes(a));
  if (hasSuperuser) return tools;

  // Filter per-tool
  return tools.filter((t) => {
    if (config.public_tools.includes(t.name)) return true;

    const requiredAcls = config.tool_acls[t.name];
    if (!requiredAcls) return config.default_policy === "open";

    return requiredAcls.some((required) => user.acls.includes(required));
  });
}

// ── Email resolution helper ────────────────────────────────────────────────

/**
 * Resolve user email from available sources (priority order).
 */
export function resolveUserEmail(
  meta?: Record<string, unknown>,
  sessionEmail?: string
): string | undefined {
  // 1. _meta.user_email (highest priority — per-request override)
  if (meta && typeof meta.user_email === "string" && meta.user_email.trim()) {
    return meta.user_email.trim();
  }

  // 2. Session email (from HTTP header in SSE mode)
  if (sessionEmail) {
    return sessionEmail;
  }

  // 3. Environment variable (stdio fallback)
  if (process.env.MCP_USER_EMAIL) {
    return process.env.MCP_USER_EMAIL.trim();
  }

  return undefined;
}

// ── Cache management ───────────────────────────────────────────────────────

/** Clear the user ACL cache (e.g. on config reload) */
export function clearAclCache(): void {
  userCache.clear();
}

/** Get cache stats for debugging */
export function getAclCacheStats(): { size: number; entries: string[] } {
  return {
    size: userCache.size,
    entries: [...userCache.keys()],
  };
}
