import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  getMessages,
} from "./db.js";
import { chat } from "./agent.js";
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
  } catch {
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
  } catch {
    res.status(500).json({ error: "Failed to logout" });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────

app.post("/api/sessions", async (req: Request, res: Response) => {
  try {
    const { title } = req.body ?? {};
    const session = await createSession(req.user!.userId, title);
    res.status(201).json(session);
  } catch (err) {
    console.error("POST /api/sessions error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.get("/api/sessions", async (req: Request, res: Response) => {
  try {
    const sessions = await listSessions(req.user!.userId);
    res.json(sessions);
  } catch (err) {
    console.error("GET /api/sessions error:", err);
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
    console.error("GET /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to get session" });
  }
});

app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
  try {
    await deleteSession(req.params.id as string, req.user!.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// ── Chat ─────────────────────────────────────────────────────────────────

app.post("/api/sessions/:id/messages", async (req: Request, res: Response) => {
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

    const result = await chat(id, message, req.user!.email);
    res.json(result);
  } catch (err) {
    console.error("POST /api/sessions/:id/messages error:", err);
    const errorMessage =
      err instanceof Error ? err.message : "Failed to process message";
    res.status(500).json({ error: errorMessage });
  }
});

// ── Health ────────────────────────────────────────────────────────────────

app.get("/api/health", async (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "mcp-client",
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929",
    mcpServer: process.env.MCP_SSE_URL || "http://localhost:3000",
  });
});

// Error logging middleware (must be last)
app.use(errorLoggingMiddleware());
