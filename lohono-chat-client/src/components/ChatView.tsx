import { useState, useEffect, useRef, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  sessions as sessionsApi,
  type Message,
  type SessionWithMessages,
} from "../api";

// Sentinel to mark messages currently being streamed (skip typewriter)
const STREAMING_MARKER = "__streaming__";

// ── Typewriter Hook (block-level reveal) ─────────────────────────────
// Reveals text one markdown block at a time (split by double newlines)
// so that tables, lists, and other structures appear as complete units.

function useTypewriter(text: string, blockDelayMs: number = 120, enabled: boolean = true) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (!enabled || !text) {
      setDisplayedText(text);
      setIsComplete(true);
      return;
    }

    // Split into markdown blocks separated by double newlines
    const blocks = text.split("\n\n");
    setDisplayedText("");
    setIsComplete(false);
    let currentBlock = 0;

    const interval = setInterval(() => {
      if (currentBlock < blocks.length) {
        currentBlock++;
        setDisplayedText(blocks.slice(0, currentBlock).join("\n\n"));
      } else {
        setIsComplete(true);
        clearInterval(interval);
      }
    }, blockDelayMs);

    return () => clearInterval(interval);
  }, [text, blockDelayMs, enabled]);

  return { displayedText, isComplete };
}

// ── MessageBubble ──────────────────────────────────────────────────────────

function MessageBubble({ msg, isLatest }: { msg: Message; isLatest: boolean }) {
  if (msg.role === "tool_use") {
    return null;
  }

  if (msg.role === "tool_result") {
    return null;
  }

  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";

  // Skip typewriter for messages that are being streamed in real-time
  const isStreaming = msg.toolUseId === STREAMING_MARKER;
  const { displayedText, isComplete } = useTypewriter(
    msg.content,
    15,
    isAssistant && isLatest && !isStreaming
  );

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-6 animate-fade-in`}>
      <div className="flex items-start gap-2 sm:gap-3 max-w-[95%] sm:max-w-[80%]">
        {/* Avatar */}
        {!isUser && (
          <div className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden shadow-lg bg-surface flex items-center justify-center p-1.5">
            <img src="/Aida.png" alt="AIDA" className="w-full h-full object-contain" />
          </div>
        )}

        <div
          className={`px-5 py-3.5 rounded-2xl shadow-md transition-all ${isUser
            ? "bg-primary text-white rounded-br-sm"
            : "bg-white text-text rounded-tl-sm border border-secondary/20"
            }`}
        >
          {isUser ? (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
          ) : (
            <div className="markdown-content text-[15px] leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayedText}</ReactMarkdown>
              {!isComplete && (
                <span className="inline-block w-1.5 h-4 bg-accent ml-0.5 animate-pulse"></span>
              )}
            </div>
          )}
        </div>

        {isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-secondary flex items-center justify-center shadow-lg">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
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
    <form onSubmit={handleSubmit} className="sticky bottom-0 border-t border-secondary/10 p-2 sm:p-4 bg-white/80 backdrop-blur-sm">
      <div className="max-w-3xl mx-auto flex items-end gap-2 sm:gap-3 bg-surface rounded-2xl px-3 sm:px-5 py-2.5 sm:py-3.5 border border-secondary/20 focus-within:border-accent/50 focus-within:shadow-lg focus-within:shadow-accent/10 transition-all">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Ask AIDA anything about your data..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-text text-[15px] resize-none outline-none placeholder-text/40 max-h-[200px] leading-relaxed"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="p-2.5 bg-primary hover:bg-primary/90 disabled:bg-secondary/30 disabled:cursor-not-allowed rounded-xl transition-all shadow-md hover:shadow-lg disabled:shadow-none flex-shrink-0"
          aria-label="Send message"
        >
          {disabled ? (
            <svg className="w-5 h-5 text-secondary animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </div>
      <p className="text-xs text-text/40 text-center mt-2">Press Enter to send, Shift+Enter for new line</p>
    </form>
  );
}

// ── Mobile Header ───────────────────────────────────────────────────────────

function MobileHeader({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-secondary/10 bg-white/80 backdrop-blur-sm">
      <button
        onClick={onMenuClick}
        className="p-2 -ml-2 text-primary hover:bg-secondary/10 rounded-lg transition-colors"
        aria-label="Open menu"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <span className="text-primary font-semibold">AIDA</span>
    </div>
  );
}

// ── ChatView ───────────────────────────────────────────────────────────────

interface ChatViewProps {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onMenuClick: () => void;
}

export default function ChatView({ sessionId, onSessionCreated, onMenuClick }: ChatViewProps) {
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

    // Create a streaming assistant message placeholder
    const streamingMsg: Message = {
      sessionId: currentSessionId,
      role: "assistant",
      content: "",
      toolUseId: STREAMING_MARKER, // marks this as being streamed
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, streamingMsg]);

    const sid = currentSessionId;

    try {
      await sessionsApi.sendMessageStream(sid, text, {
        onTextDelta: (delta) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.toolUseId === STREAMING_MARKER) {
              updated[updated.length - 1] = { ...last, content: last.content + delta };
            }
            return updated;
          });
        },
        onToolStart: (name) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.toolUseId === STREAMING_MARKER) {
              // If there was text, finalize it and add a tool indicator
              updated[updated.length - 1] = { ...last, content: last.content + `\n\n*Querying ${name}...*` };
            }
            return updated;
          });
        },
        onToolEnd: () => {
          // Remove tool indicator text — next round will stream new text
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.toolUseId === STREAMING_MARKER) {
              // Strip the "Querying..." indicator
              const cleaned = last.content.replace(/\n\n\*Querying [^*]+\.\.\.\*$/, "");
              updated[updated.length - 1] = { ...last, content: cleaned };
            }
            return updated;
          });
        },
        onDone: async () => {
          // Reload full message list from DB for consistency
          try {
            const data = await sessionsApi.get(sid);
            setMessages(data.messages);
          } catch {
            // Keep streamed messages if reload fails
          }
        },
        onError: (errorMsg) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.toolUseId === STREAMING_MARKER) {
              updated[updated.length - 1] = {
                ...last,
                content: `Error: ${errorMsg}`,
                toolUseId: undefined,
              };
            }
            return updated;
          });
        },
      });
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.toolUseId === STREAMING_MARKER) {
          updated[updated.length - 1] = {
            ...last,
            content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
            toolUseId: undefined,
          };
        } else {
          updated.push({
            sessionId: sid,
            role: "assistant",
            content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
            createdAt: new Date().toISOString(),
          });
        }
        return updated;
      });
    } finally {
      setSending(false);
    }
  };

  // Empty state
  if (!sessionId && messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col h-full bg-surface">
        <MobileHeader onMenuClick={onMenuClick} />
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-2xl">
            <div className="mb-6 inline-block">
              <img src="/aida_logo.png" alt="AIDA" className="w-40 h-40 mx-auto" />
            </div>
            <p className="text-text/60 text-lg mb-8">
              Advanced Insights & Decision Acceleration, centralized in-house data insights assistant
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
              <div className="bg-white border border-secondary/15 rounded-xl p-4 shadow-sm">
                <div className="text-secondary mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <h3 className="text-primary font-semibold mb-1">Sales Analytics</h3>
                <p className="text-text/60 text-sm">Query booking trends and revenue data</p>
              </div>
              <div className="bg-white border border-secondary/15 rounded-xl p-4 shadow-sm">
                <div className="text-primary mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                </div>
                <h3 className="text-primary font-semibold mb-1">Customer Insights</h3>
                <p className="text-text/60 text-sm">Analyze guest behavior and preferences</p>
              </div>
              <div className="bg-white border border-secondary/15 rounded-xl p-4 shadow-sm">
                <div className="text-accent mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                </div>
                <h3 className="text-primary font-semibold mb-1">Property Data</h3>
                <p className="text-text/60 text-sm">Explore funnel stages and conversions</p>
              </div>
            </div>
          </div>
        </div>
        <ChatInput onSend={handleSend} disabled={sending} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-surface">
      <MobileHeader onMenuClick={onMenuClick} />
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {messages.map((msg, i) => (
            <MessageBubble
              key={`${msg.createdAt}-${i}`}
              msg={msg}
              isLatest={i === messages.length - 1 && msg.role === "assistant"}
            />
          ))}
          {sending && !messages.some((m) => m.toolUseId === STREAMING_MARKER && m.content) && (
            <div className="flex justify-start mb-6 animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden shadow-lg bg-surface flex items-center justify-center p-1.5">
                  <img src="/Aida.png" alt="AIDA" className="w-full h-full object-contain" />
                </div>
                <div className="bg-white border border-secondary/20 rounded-2xl rounded-tl-sm px-5 py-3.5 shadow-md">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    <span className="text-text/50 text-sm ml-2">Thinking...</span>
                  </div>
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
