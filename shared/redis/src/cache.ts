import { getRedisClient, isRedisAvailable } from "./client.js";
import { logger } from "../../observability/src/logger.js";

/**
 * Generic cache backed by Redis with transparent in-memory fallback.
 * When Redis is unavailable, uses a local Map with TTL-based expiry.
 */
export class RedisCache<T> {
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  // In-memory fallback
  private readonly memCache = new Map<string, { value: T; expiresAt: number }>();

  constructor(prefix: string, ttlSeconds: number) {
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
  }

  private redisKey(key: string): string {
    // ioredis keyPrefix handles the "mcp:" prefix; we add our logical prefix
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<T | null> {
    const redis = getRedisClient();

    if (redis && isRedisAvailable()) {
      try {
        const raw = await redis.get(this.redisKey(key));
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch (err) {
        logger.warn(`RedisCache.get failed for ${this.prefix}:${key}: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through to memory cache
      }
    }

    // In-memory fallback
    const entry = this.memCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memCache.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttlOverride?: number): Promise<void> {
    const ttl = ttlOverride ?? this.ttlSeconds;
    const redis = getRedisClient();

    if (redis && isRedisAvailable()) {
      try {
        await redis.set(this.redisKey(key), JSON.stringify(value), "EX", ttl);
        return;
      } catch (err) {
        logger.warn(`RedisCache.set failed for ${this.prefix}:${key}: ${err instanceof Error ? err.message : String(err)}`);
        // Fall through to memory cache
      }
    }

    // In-memory fallback
    this.memCache.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async del(key: string): Promise<void> {
    const redis = getRedisClient();

    if (redis && isRedisAvailable()) {
      try {
        await redis.del(this.redisKey(key));
      } catch (err) {
        logger.warn(`RedisCache.del failed for ${this.prefix}:${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.memCache.delete(key);
  }

  async clear(): Promise<void> {
    const redis = getRedisClient();

    if (redis && isRedisAvailable()) {
      try {
        // SCAN-based deletion to avoid blocking with KEYS
        const pattern = `${this.prefix}:*`;
        let cursor = "0";
        do {
          // Note: ioredis keyPrefix is prepended automatically
          const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            // Keys returned by SCAN already include keyPrefix, but del() also adds it,
            // so we need to strip the keyPrefix before passing to del()
            const pipeline = redis.pipeline();
            for (const k of keys) {
              pipeline.del(k);
            }
            await pipeline.exec();
          }
        } while (cursor !== "0");
      } catch (err) {
        logger.warn(`RedisCache.clear failed for ${this.prefix}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.memCache.clear();
  }
}
