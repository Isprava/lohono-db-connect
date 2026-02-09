/**
 * PII / sensitive data sanitization for logs and span attributes.
 *
 * - Masks known sensitive field names (passwords, tokens, keys, etc.)
 * - Truncates large values to prevent log bloat
 * - Deep-clones before mutating so the original object is untouched
 */

// ── Sensitive field patterns ───────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "apikey",
  "api_key",
  "apiSecret",
  "api_secret",
  "credit_card",
  "creditcard",
  "card_number",
  "cvv",
  "ssn",
  "private_key",
  "privatekey",
  "session_token",
]);

const SENSITIVE_PATTERN = /password|secret|token|key|auth|credit|card|cvv|ssn/i;

const MASK = "***REDACTED***";
const MAX_STRING_LENGTH = 2048;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 10;

// ── Core sanitization ──────────────────────────────────────────────────────

export function sanitize(obj: unknown): unknown {
  return sanitizeValue(obj, 0);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH_EXCEEDED]";
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return truncateString(value);
    case "number":
    case "boolean":
      return value;
    case "object":
      if (Array.isArray(value)) {
        return sanitizeArray(value, depth);
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (Buffer.isBuffer(value)) {
        return `[Buffer ${value.length} bytes]`;
      }
      return sanitizeObject(value as Record<string, unknown>, depth);
    default:
      return String(value);
  }
}

function sanitizeObject(
  obj: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, "");
    if (SENSITIVE_KEYS.has(normalizedKey) || SENSITIVE_PATTERN.test(key)) {
      result[key] = MASK;
    } else {
      result[key] = sanitizeValue(value, depth + 1);
    }
  }
  return result;
}

function sanitizeArray(arr: unknown[], depth: number): unknown[] {
  const sliced = arr.slice(0, MAX_ARRAY_LENGTH);
  const result = sliced.map((item) => sanitizeValue(item, depth + 1));
  if (arr.length > MAX_ARRAY_LENGTH) {
    result.push(`[...${arr.length - MAX_ARRAY_LENGTH} more items]`);
  }
  return result;
}

function truncateString(str: string): string {
  if (str.length <= MAX_STRING_LENGTH) return str;
  return str.slice(0, MAX_STRING_LENGTH) + `[...truncated ${str.length - MAX_STRING_LENGTH} chars]`;
}

// ── Sanitize HTTP headers ──────────────────────────────────────────────────

export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "x-api-key" ||
      SENSITIVE_PATTERN.test(lower)
    ) {
      result[key] = MASK;
    } else if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

// ── Sanitize SQL query params (mask bind values) ───────────────────────────

export function sanitizeQueryParams(params?: unknown[]): string[] | undefined {
  if (!params || params.length === 0) return undefined;
  return params.map((p) => {
    if (p === null || p === undefined) return "NULL";
    if (typeof p === "number" || typeof p === "boolean") return String(p);
    const str = String(p);
    // Mask anything that looks sensitive
    if (str.length > 100) return `[string ${str.length} chars]`;
    return str;
  });
}
