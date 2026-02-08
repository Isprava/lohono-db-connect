import { useState, useEffect, useRef, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import {
  sessions as sessionsApi,
  type Message,
  type SessionWithMessages,
} from "../api";

// ── MessageBubble ──────────────────────────────────────────────────────────

function ToolCallBlock({
  name,
  input,
  result,
}: {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-2 border border-gray-700 rounded-lg overflow-hidden text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/60 hover:bg-gray-800 transition-colors text-left"
      >
        <svg
          className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-blue-400 font-mono text-xs">{name}</span>
        <span className="text-gray-500 text-xs">tool call</span>
      </button>
      {open && (
        <div className="px-3 py-2 bg-gray-900/50 space-y-2">
          {input && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Input:</p>
              <pre className="text-xs text-gray-300 bg-gray-800 p-2 rounded overflow-x-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Result:</p>
              <pre className="text-xs text-gray-300 bg-gray-800 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, nextMsg }: { msg: Message; nextMsg?: Message }) {
  if (msg.role === "tool_use") {
    // Hide tool calls from display
    return null;
  }

  if (msg.role === "tool_result") {
    // Already rendered with tool_use, skip
    return null;
  }

  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[75%] px-4 py-3 rounded-2xl ${
          isUser
            ? "bg-blue-600 text-white rounded-br-md"
            : "bg-gray-800 text-gray-100 rounded-bl-md"
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="markdown-content text-sm">
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ChatInput ──────────────────────────────────────────────────────────────

function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (msg: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-t border-gray-800 p-4">
      <div className="max-w-3xl mx-auto flex items-end gap-3 bg-gray-800 rounded-xl px-4 py-3 border border-gray-700 focus-within:border-gray-600 transition-colors">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Message Lohono AI..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-white text-sm resize-none outline-none placeholder-gray-500 max-h-[200px]"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg transition-colors flex-shrink-0"
        >
          {disabled ? (
            <svg className="w-4 h-4 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}

// ── ChatView ───────────────────────────────────────────────────────────────

interface ChatViewProps {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
}

export default function ChatView({ sessionId, onSessionCreated }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load messages when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    sessionsApi
      .get(sessionId)
      .then((data: SessionWithMessages) => setMessages(data.messages))
      .catch(console.error);
  }, [sessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (text: string) => {
    let currentSessionId = sessionId;

    // Create session if none exists
    if (!currentSessionId) {
      const session = await sessionsApi.create();
      currentSessionId = session.sessionId;
      onSessionCreated(currentSessionId);
    }

    // Optimistically add user message
    const userMsg: Message = {
      sessionId: currentSessionId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    try {
      await sessionsApi.sendMessage(currentSessionId, text);
      // Reload full message list to get all tool calls and final response
      const data = await sessionsApi.get(currentSessionId);
      setMessages(data.messages);
    } catch (err) {
      // Add error message
      setMessages((prev) => [
        ...prev,
        {
          sessionId: currentSessionId!,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  // Empty state
  if (!sessionId && messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col h-full bg-gray-900">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-gray-300 mb-2">
              Lohono AI
            </h2>
            <p className="text-gray-500 max-w-md">
              Ask questions about sales data, bookings, funnels, and more.
              I'll query the database and provide insights.
            </p>
          </div>
        </div>
        <ChatInput onSend={handleSend} disabled={sending} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-900">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {messages.map((msg, i) => (
            <MessageBubble
              key={`${msg.createdAt}-${i}`}
              msg={msg}
              nextMsg={messages[i + 1]}
            />
          ))}
          {sending && (
            <div className="flex justify-start mb-4">
              <div className="bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={sending} />
    </div>
  );
}
