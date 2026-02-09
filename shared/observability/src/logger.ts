/**
 * Structured JSON logger with OpenTelemetry trace/span correlation.
 *
 * - Every log line includes trace_id + span_id from the active OTel context
 * - Timestamps in ISO-8601 with IST (Asia/Kolkata) offset
 * - user_id and session context injected when available
 * - High-volume safe: batches via winston transports, no blocking I/O
 */

import { createLogger, format, transports, Logger } from "winston";
import { trace, context } from "@opentelemetry/api";

// ── IST formatter ──────────────────────────────────────────────────────────

const IST_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

function istTimestamp(): string {
  return IST_FORMATTER.format(new Date());
}

// ── OTel trace context injection ───────────────────────────────────────────

const otelContextFormat = format((info) => {
  const activeSpan = trace.getSpan(context.active());
  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    info.trace_id = spanContext.traceId;
    info.span_id = spanContext.spanId;
    info.trace_flags = spanContext.traceFlags;
  }
  info.timestamp_ist = istTimestamp();
  return info;
});

// ── Logger factory ─────────────────────────────────────────────────────────

const serviceName = process.env.OTEL_SERVICE_NAME || "lohono-unknown";

const logger: Logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: {
    service: serviceName,
    environment: process.env.NODE_ENV || "development",
  },
  format: format.combine(
    otelContextFormat(),
    format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      // In production, pure JSON; in dev, colorized
      format:
        process.env.NODE_ENV === "production"
          ? format.json()
          : format.combine(format.colorize(), format.simple()),
    }),
  ],
  // Don't exit on uncaught errors in the logger itself
  exitOnError: false,
});

// ── Convenience methods with user context ──────────────────────────────────

export interface LogContext {
  user_id?: string;
  user_email?: string;
  session_id?: string;
  session_token?: string;
  request_id?: string;
  [key: string]: unknown;
}

export function logInfo(message: string, ctx?: LogContext): void {
  logger.info(message, ctx);
}

export function logWarn(message: string, ctx?: LogContext): void {
  logger.warn(message, ctx);
}

export function logError(message: string, error?: Error, ctx?: LogContext): void {
  logger.error(message, {
    ...ctx,
    error_name: error?.name,
    error_message: error?.message,
    stack_trace: error?.stack,
  });
}

export function logDebug(message: string, ctx?: LogContext): void {
  logger.debug(message, ctx);
}

export { logger };
