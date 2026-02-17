import type pg from "pg";
import { logger } from "../../../shared/observability/src/logger.js";
import { RedisCache } from "../../../shared/redis/src/index.js";

interface CachedUser {
  acls: string[];
  active: boolean;
}

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes
const userCache = new RedisCache<CachedUser>("acl:user", CACHE_TTL_SECONDS);

/**
 * Query staffs table for user's acl_array by email.
 * Results are cached in Redis (with in-memory fallback) for 5 minutes.
 */
export async function resolveUserAcls(
  email: string,
  pool: pg.Pool
): Promise<{ acls: string[]; active: boolean } | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const cached = await userCache.get(normalizedEmail);
  if (cached) {
    return cached;
  }

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

    await userCache.set(normalizedEmail, { acls, active });

    return { acls, active };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(`ACL DB error resolving ACLs for ${normalizedEmail}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    client.release();
  }
}

/** Clear the user ACL cache (e.g. on config reload) */
export async function clearAclCache(): Promise<void> {
  await userCache.clear();
}

/** Get cache stats for debugging */
export function getAclCacheStats(): { info: string } {
  return { info: "Cache backed by Redis (use redis-cli KEYS mcp:acl:user:* to inspect)" };
}
