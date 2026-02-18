/**
 * Resolve user email from available sources (priority order):
 *   1. _meta.user_email in the MCP request params
 *   2. Session email (from HTTP header in SSE mode)
 *   3. MCP_USER_EMAIL environment variable (stdio fallback)
 */
export function resolveUserEmail(
  meta?: Record<string, unknown>,
  sessionEmail?: string
): string | undefined {
  if (meta && typeof meta.user_email === "string" && meta.user_email.trim()) {
    return meta.user_email.trim();
  }

  if (sessionEmail) {
    return sessionEmail;
  }

  if (process.env.MCP_USER_EMAIL) {
    return process.env.MCP_USER_EMAIL.trim();
  }

  return undefined;
}
