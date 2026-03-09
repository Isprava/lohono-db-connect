import pg from "pg";
import { logger } from "../../../shared/observability/src/logger.js";
import { CircuitBreaker } from "../../../shared/circuit-breaker/src/index.js";

const { Pool, types } = pg;

// Fix DATE parsing: return as "YYYY-MM-DD" strings instead of JS Date objects.
// Without this, pg creates Date at midnight local time (IST), which when
// serialized to JSON becomes the previous day in UTC (e.g. June 24 → June 23).
types.setTypeParser(1082, (val: string) => val); // 1082 = DATE OID

// ── Database pool ──────────────────────────────────────────────────────────

const dbHost = process.env.DB_HOST || "localhost";

const pgConfig = {
  host: dbHost,
  port: parseInt(process.env.DB_PORT || "5433"),
  user: process.env.DB_USER || "lohono_api",
  database: process.env.DB_NAME || "lohono_api_production",
  password: process.env.DB_PASSWORD || "",
  ssl:
    process.env.DB_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
};

logger.info("Initializing PG pool", {
  host: pgConfig.host,
  port: pgConfig.port,
  user: pgConfig.user,
  database: pgConfig.database,
});

export const pool = new Pool(pgConfig);

pool.on("connect", () => {
  logger.info("PG pool: new client connected", {
    host: pgConfig.host,
    database: pgConfig.database,
  });
});

pool.on("error", (err) => {
  logger.error("PG pool: unexpected error on idle client", {
    error: err.message,
  });
});

// ── Circuit breaker for PG queries ────────────────────────────────────────

const dbCircuitBreaker = new CircuitBreaker({
  name: "postgresql",
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

/** Get the current circuit breaker state for health checks */
export function getDbCircuitState() {
  return dbCircuitBreaker.getState();
}

// ── Read-only query helper ───────────────────────────────────────────

export async function executeReadOnlyQuery(sql: string, params?: unknown[]) {
  return dbCircuitBreaker.execute(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
