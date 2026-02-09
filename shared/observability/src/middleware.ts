/**
 * Express middleware for structured HTTP request/response logging.
 *
 * - Logs every request with method, path, status, duration, user context
 * - Sanitizes request bodies (PII masking)
 * - Enriches the active OTel span with user_id, session attributes
 * - Injects X-Correlation-ID header (trace_id) into responses
 */

import { Request, Response, NextFunction } from "express";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { logInfo, logWarn, logError } from "./logger.js";
import { sanitize, sanitizeHeaders } from "./sanitize.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface UserPublic {
  userId: string;
  email: string;
  name: string;
  picture: string;
}

// ── Request logging middleware ──────────────────────────────────────────────

export function requestLoggingMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = process.hrtime.bigint();
    const activeSpan = trace.getSpan(context.active());
    const traceId = activeSpan?.spanContext().traceId || "no-trace";

    // Inject correlation ID header into response
    res.setHeader("X-Correlation-ID", traceId);

    // Extract user context (set by authMiddleware upstream)
    const user = (req as Request & { user?: UserPublic }).user;
    const authToken = (req as Request & { authToken?: string }).authToken;

    // Enrich active span with user attributes
    if (activeSpan) {
      if (user) {
        activeSpan.setAttribute("user.id", user.userId);
        activeSpan.setAttribute("user.email", user.email);
        activeSpan.setAttribute("user.name", user.name);
      }
      if (req.params.id) {
        activeSpan.setAttribute("session.id", req.params.id);
      }
      activeSpan.setAttribute("http.route", req.route?.path || req.path);
    }

    // Log the incoming request
    logInfo("HTTP request received", {
      request_id: traceId,
      user_id: user?.userId,
      user_email: user?.email,
      session_token: authToken ? `${authToken.slice(0, 8)}...` : undefined,
      http_method: req.method,
      http_path: req.path,
      http_query: Object.keys(req.query).length > 0
        ? sanitize(req.query) as Record<string, unknown>
        : undefined,
      request_body: req.body && Object.keys(req.body).length > 0
        ? sanitize(req.body)
        : undefined,
      client_ip: req.ip || req.socket.remoteAddress,
      user_agent: req.headers["user-agent"],
    });

    // Capture response on finish
    const originalEnd = res.end;
    res.end = function (this: Response, ...args: Parameters<typeof res.end>) {
      const durationNs = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNs / 1_000_000n);
      const statusCode = res.statusCode;

      // Enrich span with response info
      if (activeSpan) {
        activeSpan.setAttribute("http.response.status_code", statusCode);
        activeSpan.setAttribute("http.response.duration_ms", durationMs);
        if (statusCode >= 500) {
          activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${statusCode}`,
          });
        }
      }

      const logCtx = {
        request_id: traceId,
        user_id: user?.userId,
        user_email: user?.email,
        http_method: req.method,
        http_path: req.path,
        http_status: statusCode,
        duration_ms: durationMs,
      };

      if (statusCode >= 500) {
        logError(`HTTP ${statusCode} ${req.method} ${req.path}`, undefined, logCtx);
      } else if (statusCode >= 400) {
        logWarn(`HTTP ${statusCode} ${req.method} ${req.path}`, logCtx);
      } else {
        logInfo(`HTTP ${statusCode} ${req.method} ${req.path}`, logCtx);
      }

      return originalEnd.apply(this, args);
    } as typeof res.end;

    next();
  };
}

// ── Error logging middleware (must be registered last) ─────────────────────

export function errorLoggingMiddleware() {
  return (err: Error, req: Request, res: Response, next: NextFunction): void => {
    const activeSpan = trace.getSpan(context.active());
    const traceId = activeSpan?.spanContext().traceId || "no-trace";
    const user = (req as Request & { user?: UserPublic }).user;

    if (activeSpan) {
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      activeSpan.recordException(err);
    }

    logError("Unhandled Express error", err, {
      request_id: traceId,
      user_id: user?.userId,
      user_email: user?.email,
      http_method: req.method,
      http_path: req.path,
    });

    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", trace_id: traceId });
    }

    next(err);
  };
}
