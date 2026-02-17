import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  getMessages,
} from "./db.js";
import { chat, chatStream, getClaudeCircuitState } from "./agent.js";
import { getMcpCircuitStates } from "./mcp-bridge.js";
import {
  authenticateGoogleUser,
  validateSession,
  deleteSessionByToken,
  type UserPublic,
} from "./auth.js";
import {
  requestLoggingMiddleware,
  errorLoggingMiddleware,
  logInfo,
  logError,
} from "../../shared/observability/src/index.js";
import { Vertical, isValidVertical } from "../../shared/types/verticals.js";

// ── Extend Express Request ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
      authToken?: string;
    }
  }
}

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
  if (req.path.startsWith("/api/auth/") || req.path === "/api/health") {
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
    res.json(req.user);
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

    for await (const event of chatStream(id, message, req.user!.email)) {
      if (aborted) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (!aborted) {
      res.end();
    }
  } catch (err) {
    logError("GET /api/sessions/:id/messages/stream failed", err instanceof Error ? err : new Error(String(err)), { sessionId: req.params.id });
    // If headers already sent, we can't send JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message" });
    } else {
      res.write(`data: ${JSON.stringify({ event: "error", data: { message: "Internal server error" } })}\n\n`);
      res.end();
    }
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
