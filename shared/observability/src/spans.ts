/**
 * Custom OpenTelemetry span helpers for:
 * - MCP tool calls (client → server)
 * - Database queries (Postgres, MongoDB)
 * - Claude/Anthropic API calls
 * - SSE session lifecycle
 *
 * These wrap application-level operations with semantic spans
 * that auto-propagate context across service boundaries.
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { sanitize, sanitizeQueryParams } from "./sanitize.js";
import { logInfo, logError, logDebug } from "./logger.js";

// ── Tracer singleton ───────────────────────────────────────────────────────

const TRACER_NAME = "lohono-ai-custom";

function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, "1.0.0");
}

// ── MCP Tool Call spans ────────────────────────────────────────────────────

export interface MCPToolCallOptions {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userEmail?: string;
  sessionId?: string;
}

/**
 * Wraps an MCP tool call with a custom span.
 * Use this in the MCP client bridge when calling tools on the MCP server.
 */
export async function withMCPToolSpan<T>(
  options: MCPToolCallOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `mcp.tool.${options.toolName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "mcp.tool.name": options.toolName,
        "mcp.tool.args": JSON.stringify(sanitize(options.toolArgs)),
        "mcp.session.id": options.sessionId || "",
        "user.email": options.userEmail || "",
      },
    },
    async (span) => {
      try {
        logDebug(`MCP tool call: ${options.toolName}`, {
          user_email: options.userEmail,
          session_id: options.sessionId,
          tool_args: sanitize(options.toolArgs) as Record<string, unknown>,
        });

        const result = await fn(span);

        span.setStatus({ code: SpanStatusCode.OK });
        logInfo(`MCP tool call completed: ${options.toolName}`, {
          user_email: options.userEmail,
          session_id: options.sessionId,
        });

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);

        logError(`MCP tool call failed: ${options.toolName}`, error, {
          user_email: options.userEmail,
          session_id: options.sessionId,
        });

        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ── MCP Server tool handler span ───────────────────────────────────────────

export interface MCPServerToolOptions {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userEmail?: string;
}

/**
 * Wraps an MCP server-side tool handler with a span.
 * Use this in the MCP server's handleToolCall function.
 */
export async function withMCPServerToolSpan<T>(
  options: MCPServerToolOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `mcp.server.tool.${options.toolName}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "mcp.tool.name": options.toolName,
        "mcp.tool.args_summary": JSON.stringify(sanitize(options.toolArgs)).slice(0, 512),
        "user.email": options.userEmail || "",
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ── Postgres query spans ───────────────────────────────────────────────────

export interface PGQueryOptions {
  sql: string;
  params?: unknown[];
  operation?: string; // e.g. "read_only_query", "staff_check"
}

/**
 * Wraps a Postgres query with a custom span.
 * NOTE: The pg auto-instrumentation already creates spans; use this for
 * application-level semantic context (e.g., "read-only query" vs "auth check").
 */
export async function withPGQuerySpan<T>(
  options: PGQueryOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  const opName = options.operation || "pg.query";
  return tracer.startActiveSpan(
    `db.postgres.${opName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": opName,
        "db.statement": options.sql.slice(0, 1024), // truncate large queries
        "db.params": options.params
          ? JSON.stringify(sanitizeQueryParams(options.params))
          : undefined,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ── MongoDB operation spans ────────────────────────────────────────────────

export interface MongoOpOptions {
  collection: string;
  operation: string; // e.g. "findOne", "insertOne", "updateOne"
  filter?: Record<string, unknown>;
}

/**
 * Wraps a MongoDB operation with a custom span.
 */
export async function withMongoSpan<T>(
  options: MongoOpOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `db.mongodb.${options.collection}.${options.operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "mongodb",
        "db.collection": options.collection,
        "db.operation": options.operation,
        "db.filter": options.filter
          ? JSON.stringify(sanitize(options.filter)).slice(0, 512)
          : undefined,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ── Claude / Anthropic API spans ───────────────────────────────────────────

export interface ClaudeCallOptions {
  model: string;
  sessionId: string;
  round: number;
  toolCount: number;
}

/**
 * Wraps a Claude API call with a span.
 */
export async function withClaudeSpan<T>(
  options: ClaudeCallOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `llm.claude.messages.create`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "llm.provider": "anthropic",
        "llm.model": options.model,
        "llm.session_id": options.sessionId,
        "llm.round": options.round,
        "llm.tool_count": options.toolCount,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

// ── SSE session span ───────────────────────────────────────────────────────

/**
 * Creates a long-lived span for an SSE session.
 * Returns the span so the caller can end it when the connection closes.
 */
export function startSSESessionSpan(userEmail?: string): Span {
  const tracer = getTracer();
  const span = tracer.startSpan("mcp.sse.session", {
    kind: SpanKind.SERVER,
    attributes: {
      "mcp.transport": "sse",
      "user.email": userEmail || "anonymous",
    },
  });

  logInfo("SSE session started", { user_email: userEmail });

  return span;
}

// ── Generic operation wrapper ──────────────────────────────────────────────

/**
 * Generic span wrapper for any named operation.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  // Filter out undefined values
  const cleanAttrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  return tracer.startActiveSpan(name, { attributes: cleanAttrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw err;
    } finally {
      span.end();
    }
  });
}
