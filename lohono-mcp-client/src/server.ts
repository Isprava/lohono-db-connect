import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  getMessages,
  getAllToolAcls,
  upsertToolAcls,
  deleteToolAcl,
  getToolAclsMap,
  getGlobalAclConfig,
  upsertGlobalAclConfig,
  getGlobalAclConfigForRedis,
} from "./db.js";
import { chat, chatStream, getClaudeCircuitState } from "./agent.js";
import { getMcpCircuitStates, getToolNames } from "./mcp-bridge.js";
import {
  authenticateGoogleUser,
  validateSession,
  deleteSessionByToken,
  getPgPool,
  type UserPublic,
} from "./auth.js";
import {
  requestLoggingMiddleware,
  errorLoggingMiddleware,
  logInfo,
  logError,
} from "../../shared/observability/src/index.js";
import { Vertical, isValidVertical } from "../../shared/types/verticals.js";
import { RedisCache } from "../../shared/redis/src/index.js";

// ── Extend Express Request ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
      authToken?: string;
      isAdmin?: boolean;
    }
  }
}

// ── Redis caches for ACL config (synced to MCP Server) ──────────────────────

const aclToolConfigCache = new RedisCache<Record<string, string[]>>("acl:tool_config", 0);
const aclGlobalConfigCache = new RedisCache<{
  default_policy: "open" | "deny";
  public_tools: string[];
  disabled_tools: string[];
}>("acl:global_config", 0);

// ── Express app ────────────────────────────────────────────────────────────

export const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLoggingMiddleware());

// ── Rate limiting ───────────────────────────────────────────────────────────

/** General API rate limit: 60 requests per minute per user/IP */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.email || req.ip || "anonymous",
  skip: (req: Request) => req.path === "/api/health",
  message: { error: "Too many requests, please try again later" },
});

/** Chat endpoint rate limit: 20 requests per minute (expensive — Claude API calls) */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.email || req.ip || "anonymous",
  message: { error: "Too many chat requests, please wait before sending another message" },
});

app.use("/api/", generalLimiter);

// ── Auth middleware ─────────────────────────────────────────────────────────

async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const publicPaths = ["/api/auth/google", "/api/auth/logout", "/api/health"];
  if (publicPaths.includes(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization token required" });
    return;
  }

  const token = authHeader.slice(7);
  const user = await validateSession(token);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  req.user = user;
  req.authToken = token;
  next();
}

app.use(authMiddleware);

// ── Auth routes ────────────────────────────────────────────────────────────

app.post("/api/auth/google", async (req: Request, res: Response) => {
  try {
    const { userProfile } = req.body ?? {};
    if (!userProfile || typeof userProfile !== "string") {
      res.status(400).json({ error: "userProfile (base64 string) is required" });
      return;
    }
    const result = await authenticateGoogleUser(userProfile);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    const status = message.startsWith("Access denied") ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

app.get("/api/auth/me", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    // Check if user is admin (role_id = 1)
    let isAdmin = false;
    try {
      const pool = getPgPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const result = await client.query(
          `SELECT role_id FROM public.staffs WHERE LOWER(email) = $1 LIMIT 1`,
          [req.user.email.toLowerCase()]
        );
        await client.query("COMMIT");
        if (result.rows.length > 0 && result.rows[0].role_id === 1) {
          isAdmin = true;
        }
      } finally {
        client.release();
      }
    } catch (err) {
      logError("Failed to check admin role", err instanceof Error ? err : new Error(String(err)));
    }
    res.json({ ...req.user, isAdmin });
  } catch (err) {
    logError("GET /api/auth/me failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to get profile" });
  }
});

app.post("/api/auth/logout", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      await deleteSessionByToken(authHeader.slice(7));
    }
    res.json({ ok: true });
  } catch (err) {
    logError("POST /api/auth/logout failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to logout" });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────

app.post("/api/sessions", async (req: Request, res: Response) => {
  try {
    const { title, vertical } = req.body ?? {};
    // Validate vertical if provided
    const validVertical = vertical && isValidVertical(vertical) ? vertical as Vertical : undefined;
    const session = await createSession(req.user!.userId, title, validVertical);
    res.status(201).json(session);
  } catch (err) {
    logError("POST /api/sessions failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.get("/api/sessions", async (req: Request, res: Response) => {
  try {
    const sessions = await listSessions(req.user!.userId);
    res.json(sessions);
  } catch (err) {
    logError("GET /api/sessions failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

app.get("/api/sessions/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const session = await getSession(id, req.user!.userId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const messages = await getMessages(id);
    res.json({ ...session, messages });
  } catch (err) {
    logError("GET /api/sessions/:id failed", err instanceof Error ? err : new Error(String(err)), { sessionId: req.params.id });
    res.status(500).json({ error: "Failed to get session" });
  }
});

app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
  try {
    await deleteSession(req.params.id as string, req.user!.userId);
    res.json({ ok: true });
  } catch (err) {
    logError("DELETE /api/sessions/:id failed", err instanceof Error ? err : new Error(String(err)), { sessionId: req.params.id });
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// ── Chat ─────────────────────────────────────────────────────────────────

app.post("/api/sessions/:id/messages", chatLimiter, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { message } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: '"message" (string) is required' });
      return;
    }

    const session = await getSession(id, req.user!.userId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Pass vertical from session to chat function
    const result = await chat(id, message, req.user!.email, session.vertical);
    res.json(result);
  } catch (err) {
    logError("POST /api/sessions/:id/messages failed", err instanceof Error ? err : new Error(String(err)), { sessionId: req.params.id });
    const errorMessage =
      err instanceof Error ? err.message : "Failed to process message";
    res.status(500).json({ error: errorMessage });
  }
});

// ── Streaming Chat (SSE) ──────────────────────────────────────────────────

app.get("/api/sessions/:id/messages/stream", chatLimiter, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const message = req.query.message as string | undefined;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: '"message" query parameter (string) is required' });
      return;
    }

    const session = await getSession(id, req.user!.userId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    // Handle client disconnect
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    for await (const event of chatStream(id, message, req.user!.email, session.vertical)) {
      if (aborted) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (!aborted) {
      res.end();
    }
  } catch (err) {
    logError("GET /api/sessions/:id/messages/stream failed", err instanceof Error ? err : new Error(String(err)), { sessionId: req.params.id });

    // Parse a user-friendly error message
    let userMessage = "Something went wrong. Please try again.";
    try {
      const raw = err instanceof Error ? err.message : String(err);
      const parsed = JSON.parse(raw);
      if (parsed?.error?.type === "overloaded_error") {
        userMessage = "The AI service is currently busy. Please wait a moment and try again.";
      } else if (parsed?.error?.type === "rate_limit_error") {
        userMessage = "Too many requests. Please wait a moment and try again.";
      } else if (parsed?.error?.message) {
        userMessage = parsed.error.message;
      }
    } catch {
      // Not JSON — use default message
    }

    if (!res.headersSent) {
      res.status(500).json({ error: userMessage });
    } else {
      res.write(`data: ${JSON.stringify({ event: "error", data: { message: userMessage } })}\n\n`);
      res.end();
    }
  }
});

// ── Admin middleware (role_id = 1) ─────────────────────────────────────────

async function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  try {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(
        `SELECT role_id FROM public.staffs WHERE LOWER(email) = $1 LIMIT 1`,
        [req.user.email.toLowerCase()]
      );
      await client.query("COMMIT");

      if (result.rows.length === 0 || result.rows[0].role_id !== 1) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logError("Admin middleware failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to verify admin access" });
    return;
  }

  req.isAdmin = true;
  next();
}

/** Sync the full ACL config (global + tool_acls) from MongoDB to Redis */
async function syncAclToRedis(): Promise<void> {
  try {
    const [toolAclsMap, globalConfig] = await Promise.all([
      getToolAclsMap(),
      getGlobalAclConfigForRedis(),
    ]);
    await Promise.all([
      aclToolConfigCache.set("current", toolAclsMap),
      aclGlobalConfigCache.set("current", globalConfig),
    ]);
    logInfo("ACL config synced to Redis", { tool_count: String(Object.keys(toolAclsMap).length) });
  } catch (err) {
    logError("Failed to sync ACL to Redis", err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Admin: ACL Management ─────────────────────────────────────────────────

/** List all tool ACL configs from MongoDB */
app.get("/api/admin/acl/tools", adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const configs = await getAllToolAcls();
    res.json(configs);
  } catch (err) {
    logError("GET /api/admin/acl/tools failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to list ACL configs" });
  }
});

/** Upsert ACLs for a tool */
app.put("/api/admin/acl/tools/:toolName", adminMiddleware, async (req: Request, res: Response) => {
  try {
    const toolName = req.params.toolName as string;
    const { acls } = req.body ?? {};
    if (!Array.isArray(acls) || !acls.every((a: unknown) => typeof a === "string")) {
      res.status(400).json({ error: '"acls" must be an array of strings' });
      return;
    }
    const config = await upsertToolAcls(toolName, acls, req.user!.email);
    await syncAclToRedis();
    res.json(config);
  } catch (err) {
    logError("PUT /api/admin/acl/tools/:toolName failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to update ACL config" });
  }
});

/** Delete ACL config for a tool */
app.delete("/api/admin/acl/tools/:toolName", adminMiddleware, async (req: Request, res: Response) => {
  try {
    await deleteToolAcl(req.params.toolName as string);
    await syncAclToRedis();
    res.json({ ok: true });
  } catch (err) {
    logError("DELETE /api/admin/acl/tools/:toolName failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to delete ACL config" });
  }
});

/** Get global ACL config (policy, public/disabled tools) */
app.get("/api/admin/acl/global", adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const config = await getGlobalAclConfig();
    res.json(config);
  } catch (err) {
    logError("GET /api/admin/acl/global failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to get global ACL config" });
  }
});

/** Update global ACL config */
app.put("/api/admin/acl/global", adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { default_policy, public_tools, disabled_tools } = req.body ?? {};
    if (default_policy && !["open", "deny"].includes(default_policy)) {
      res.status(400).json({ error: '"default_policy" must be "open" or "deny"' });
      return;
    }
    if (public_tools && (!Array.isArray(public_tools) || !public_tools.every((a: unknown) => typeof a === "string"))) {
      res.status(400).json({ error: '"public_tools" must be an array of strings' });
      return;
    }
    if (disabled_tools && (!Array.isArray(disabled_tools) || !disabled_tools.every((a: unknown) => typeof a === "string"))) {
      res.status(400).json({ error: '"disabled_tools" must be an array of strings' });
      return;
    }

    // Merge with existing config so partial updates work
    const existing = await getGlobalAclConfig();
    const config = await upsertGlobalAclConfig({
      default_policy: default_policy ?? existing.default_policy,
      public_tools: public_tools ?? existing.public_tools,
      disabled_tools: disabled_tools ?? existing.disabled_tools,
    }, req.user!.email);
    await syncAclToRedis();
    res.json(config);
  } catch (err) {
    logError("PUT /api/admin/acl/global failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to update global ACL config" });
  }
});

/** List all available ACL names from constant_mappings (ACL_CONSTANTS) */
app.get("/api/admin/acl/available-acls", adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(
        `SELECT value FROM public.constant_mappings WHERE name = 'ACL_CONSTANTS' LIMIT 1`
      );
      await client.query("COMMIT");
      if (result.rows.length === 0 || !result.rows[0].value) {
        res.json([]);
        return;
      }
      const acls = (result.rows[0].value as string)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
        .sort();
      res.json(acls);
    } finally {
      client.release();
    }
  } catch (err) {
    logError("GET /api/admin/acl/available-acls failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to list available ACLs" });
  }
});

/** List all registered MCP tool names */
app.get("/api/admin/acl/available-tools", adminMiddleware, async (_req: Request, res: Response) => {
  try {
    const tools = getToolNames();
    res.json(tools);
  } catch (err) {
    logError("GET /api/admin/acl/available-tools failed", err instanceof Error ? err : new Error(String(err)));
    res.status(500).json({ error: "Failed to list available tools" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────

app.get("/api/health", async (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "mcp-client",
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929",
    mcpServer: process.env.MCP_SSE_URL || "http://localhost:3000",
    circuits: {
      claude: getClaudeCircuitState(),
      mcp: getMcpCircuitStates(),
    },
  });
});

// Error logging middleware (must be last)
app.use(errorLoggingMiddleware());
