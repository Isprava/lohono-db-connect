/**
 * Observability barrel export.
 *
 * NOTE: Do NOT import this file for the SDK bootstrap.
 *       Import "./observability/tracing.js" directly as the FIRST import
 *       in your entrypoint. This file is for convenience access to
 *       logger, middleware, spans, and sanitize utilities.
 */

export { logger, logInfo, logWarn, logError, logDebug } from "./logger.js";
export type { LogContext } from "./logger.js";

export { requestLoggingMiddleware, errorLoggingMiddleware } from "./middleware.js";

export { sanitize, sanitizeHeaders, sanitizeQueryParams } from "./sanitize.js";

export {
  withMCPToolSpan,
  withMCPServerToolSpan,
  withPGQuerySpan,
  withMongoSpan,
  withClaudeSpan,
  withSpan,
  startSSESessionSpan,
} from "./spans.js";

export type {
  MCPToolCallOptions,
  MCPServerToolOptions,
  PGQueryOptions,
  MongoOpOptions,
  ClaudeCallOptions,
} from "./spans.js";
