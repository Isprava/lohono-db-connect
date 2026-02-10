const API_BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  { skipAuthRedirect = false } = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 401) {
    if (!skipAuthRedirect) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/auth/callback";
    }
    throw new Error("Unauthorized");
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export interface UserPublic {
  userId: string;
  email: string;
  name: string;
  picture: string;
}

export interface AuthResponse {
  token: string;
  user: UserPublic;
}

export const auth = {
  google: (userProfile: string) =>
    request<AuthResponse>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ userProfile }),
    }),
  me: () => request<UserPublic>("/auth/me", {}, { skipAuthRedirect: true }),
  logout: () =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
};

// ── Sessions ───────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  sessionId: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  createdAt: string;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface ChatResult {
  assistantText: string;
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
}

export const sessions = {
  list: () => request<Session[]>("/sessions"),
  create: (title?: string) =>
    request<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  get: (id: string) => request<SessionWithMessages>(`/sessions/${id}`),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }),
  sendMessage: (id: string, message: string) =>
    request<ChatResult>(`/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
};
