import { MongoClient, type Db } from "mongodb";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { logger } from "../../../shared/observability/src/logger.js";
import type { AclConfig } from "./types.js";

// ── MongoDB connection (lazy singleton) ─────────────────────────────────

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let mongoConnecting: Promise<Db> | null = null;

async function getMongoDb(): Promise<Db | null> {
  if (mongoDb) return mongoDb;
  if (mongoConnecting) return mongoConnecting;

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB_NAME || "mcp_client";

  mongoConnecting = (async () => {
    try {
      mongoClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await mongoClient.connect();
      mongoDb = mongoClient.db(dbName);
      logger.info(`ACL config: MongoDB connected (${uri}/${dbName})`);
      return mongoDb;
    } catch (err) {
      logger.warn(`ACL config: MongoDB unavailable, using YAML fallback: ${err instanceof Error ? err.message : String(err)}`);
      mongoConnecting = null;
      throw err;
    }
  })();

  return mongoConnecting;
}

// ── YAML fallback (loaded once from disk) ───────────────────────────────

let yamlConfig: AclConfig | null = null;

function loadYamlFallback(): AclConfig {
  if (yamlConfig) return yamlConfig;

  const configPath = process.env.ACL_CONFIG_PATH
    || resolve(process.cwd(), "database/schema/acl.yml");

  if (!existsSync(configPath)) {
    logger.warn(`ACL YAML config not found at: ${configPath}, using defaults (tool_acls will be loaded from MongoDB only)`);
    yamlConfig = {
      default_policy: "open",
      public_tools: [],
      disabled_tools: [],
      tool_acls: {}, // Empty - tool_acls now come ONLY from MongoDB
    };
    return yamlConfig;
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = yaml.load(raw) as Record<string, unknown>;

    yamlConfig = {
      default_policy: (parsed.default_policy as "open" | "deny") || "open",
      public_tools: (parsed.public_tools as string[]) || [],
      disabled_tools: (parsed.disabled_tools as string[]) || [],
      tool_acls: {}, // REMOVED: tool_acls are now loaded ONLY from MongoDB
    };
    logger.info(`ACL global config loaded from YAML (tool_acls ignored - using MongoDB only): ${configPath}`);
    return yamlConfig;
  } catch (err) {
    logger.error(`Failed to parse ACL YAML: ${err instanceof Error ? err.message : String(err)}`);
    yamlConfig = {
      default_policy: "open",
      public_tools: [],
      disabled_tools: [],
      tool_acls: {}, // Empty - tool_acls come from MongoDB only
    };
    return yamlConfig;
  }
}

// ── In-memory cache with TTL ────────────────────────────────────────────

let cachedConfig: AclConfig | null = null;
let cachedConfigExpiresAt = 0;

const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Fetch ACL config from MongoDB.
 * MongoDB stores two collections (same as MCP Client writes):
 *   - acl_global_config: single doc with default_policy, public_tools, disabled_tools
 *   - acl_configs: per-tool docs with { toolName, acls }
 *
 * Falls back to YAML file for global config only if MongoDB is unavailable.
 * Tool ACLs (tool_acls) are ALWAYS loaded from MongoDB only.
 */
async function fetchFromMongo(): Promise<AclConfig> {
  const yamlFallback = loadYamlFallback();

  let db: Db | null = null;
  try {
    db = await getMongoDb();
  } catch {
    logger.warn("MongoDB unavailable, using YAML for global config (tool_acls will be empty)");
    return yamlFallback;
  }

  if (!db) {
    logger.warn("MongoDB connection not established, using YAML for global config (tool_acls will be empty)");
    return yamlFallback;
  }

  try {
    const [globalDoc, toolDocs] = await Promise.all([
      db.collection("acl_global_config").findOne({}),
      db.collection("acl_configs").find().toArray(),
    ]);

    // Build tool_acls map from MongoDB docs ONLY (no YAML merge)
    const mongoToolAcls: Record<string, string[]> = {};
    for (const doc of toolDocs) {
      const toolName = doc.toolName as string;
      const acls = doc.acls as string[];
      if (toolName && Array.isArray(acls)) {
        mongoToolAcls[toolName] = acls;
      }
    }

    if (globalDoc && globalDoc.default_policy) {
      // MongoDB has global config — use it with MongoDB-only tool_acls
      return {
        default_policy: globalDoc.default_policy as "open" | "deny",
        public_tools: (globalDoc.public_tools as string[]) || yamlFallback.public_tools,
        disabled_tools: (globalDoc.disabled_tools as string[]) || yamlFallback.disabled_tools,
        tool_acls: mongoToolAcls, // ONLY from MongoDB
      };
    }

    // No global config in MongoDB — use YAML global config + MongoDB-only tool_acls
    return {
      default_policy: yamlFallback.default_policy,
      public_tools: yamlFallback.public_tools,
      disabled_tools: yamlFallback.disabled_tools,
      tool_acls: mongoToolAcls, // ONLY from MongoDB
    };
  } catch (err) {
    logger.warn(`ACL config: MongoDB query failed, using YAML fallback (tool_acls will be empty): ${err instanceof Error ? err.message : String(err)}`);
    return yamlFallback;
  }
}

/**
 * Get the effective ACL config from MongoDB (direct read).
 * Falls back to YAML file for global config if MongoDB is unavailable.
 * Tool ACLs (tool_acls) are ALWAYS loaded from MongoDB only.
 * Results are cached in-memory for 30 seconds.
 */
export async function getEffectiveAclConfig(): Promise<AclConfig> {
  const now = Date.now();
  if (cachedConfig !== null && now < cachedConfigExpiresAt) {
    return cachedConfig;
  }

  const config = await fetchFromMongo();
  cachedConfig = config;
  cachedConfigExpiresAt = now + CACHE_TTL_MS;
  return config;
}

/** Clear in-memory caches (useful for testing) */
export function clearAclConfigCache(): void {
  cachedConfig = null;
  cachedConfigExpiresAt = 0;
}

/** Disconnect MongoDB (for graceful shutdown) */
export async function disconnectAclMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    mongoDb = null;
    mongoConnecting = null;
  }
}
