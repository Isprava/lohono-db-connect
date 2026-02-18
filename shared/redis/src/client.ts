import { Redis } from "ioredis";
import { logger } from "../../observability/src/logger.js";

const KEY_PREFIX = "mcp:";

let redisClient: Redis | null = null;
let available = false;

/**
 * Get or create the singleton Redis client.
 * Returns null if REDIS_URL is not configured.
 */
export function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info("REDIS_URL not set — using in-memory cache fallback");
    return null;
  }

  redisClient = new Redis(url, {
    keyPrefix: KEY_PREFIX,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000);
    },
    lazyConnect: false,
  });

  redisClient.on("connect", () => {
    available = true;
    logger.info("Redis connected");
  });

  redisClient.on("error", (err: Error) => {
    available = false;
    logger.warn(`Redis error: ${err.message}`);
  });

  redisClient.on("close", () => {
    available = false;
  });

  redisClient.on("reconnecting", () => {
    logger.info("Redis reconnecting...");
  });

  return redisClient;
}

/** Check if Redis is currently connected and available. */
export function isRedisAvailable(): boolean {
  return available && redisClient?.status === "ready";
}

/** Gracefully disconnect Redis (for shutdown). */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    available = false;
  }
}
