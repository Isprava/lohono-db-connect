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

// ── SSE Stream types ──────────────────────────────────────────────────────

export type StreamEvent =
  | { event: "text_delta"; data: { text: string } }
  | { event: "tool_start"; data: { name: string; id: string } }
  | { event: "tool_end"; data: { name: string; id: string } }
  | { event: "done"; data: { assistantText: string } }
  | { event: "error"; data: { message: string } };

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

  /**
   * Stream a chat message response via SSE.
   * Uses fetch + ReadableStream (not EventSource) so we can include auth headers.
   */
  sendMessageStream: async (
    id: string,
    message: string,
    callbacks: {
      onTextDelta: (text: string) => void;
      onToolStart?: (name: string, toolId: string) => void;
      onToolEnd?: (name: string, toolId: string) => void;
      onDone: (assistantText: string) => void;
      onError: (error: string) => void;
    }
  ): Promise<void> => {
    const token = getToken();
    const url = `${API_BASE}/sessions/${id}/messages/stream?message=${encodeURIComponent(message)}`;

    const res = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: "same-origin",
    });

    if (res.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/auth/callback";
      throw new Error("Unauthorized");
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines: "data: {...}\n\n"
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || ""; // keep incomplete last chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(trimmed.slice(6)) as StreamEvent;
          switch (event.event) {
            case "text_delta":
              callbacks.onTextDelta(event.data.text);
              break;
            case "tool_start":
              callbacks.onToolStart?.(event.data.name, event.data.id);
              break;
            case "tool_end":
              callbacks.onToolEnd?.(event.data.name, event.data.id);
              break;
            case "done":
              callbacks.onDone(event.data.assistantText);
              break;
            case "error":
              callbacks.onError(event.data.message);
              break;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  },
};
