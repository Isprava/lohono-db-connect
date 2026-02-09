import { useState, useEffect, useRef, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import {
  sessions as sessionsApi,
  type Message,
  type SessionWithMessages,
} from "../api";

// ── Typewriter Hook ───────────────────────────────────────────────────

function useTypewriter(text: string, speed: number = 20, enabled: boolean = true) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setDisplayedText(text);
      setIsComplete(true);
      return;
    }

    setDisplayedText("");
    setIsComplete(false);
    let currentIndex = 0;

    const interval = setInterval(() => {
      if (currentIndex < text.length) {
        setDisplayedText(text.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        setIsComplete(true);
        clearInterval(interval);
      }
    }, speed);

    return () => clearInterval(interval);
  }, [text, speed, enabled]);

  return { displayedText, isComplete };
}

// ── MessageBubble ──────────────────────────────────────────────────────────

// Unused for now - can be used to display tool calls in the future
// function ToolCallBlock({
//   name,
//   input,
//   result,
// }: {
//   name: string;
//   input?: Record<string, unknown>;
//   result?: string;
// }) {
//   const [open, setOpen] = useState(false);

//   return (
//     <div className="my-2 border border-gray-700 rounded-lg overflow-hidden text-sm">
//       <button
//         onClick={() => setOpen(!open)}
//         className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/60 hover:bg-gray-800 transition-colors text-left"
//       >
//         <svg
//           className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? "rotate-90" : ""}`}
//           fill="none"
//           stroke="currentColor"
//           viewBox="0 0 24 24"
//         >
//           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
//         </svg>
//         <span className="text-blue-400 font-mono text-xs">{name}</span>
//         <span className="text-gray-500 text-xs">tool call</span>
//       </button>
//       {open && (
//         <div className="px-3 py-2 bg-gray-900/50 space-y-2">
//           {input && (
//             <div>
//               <p className="text-xs text-gray-500 mb-1">Input:</p>
//               <pre className="text-xs text-gray-300 bg-gray-800 p-2 rounded overflow-x-auto">
//                 {JSON.stringify(input, null, 2)}
//               </pre>
//             </div>
//           )}
//           {result && (
//             <div>
//               <p className="text-xs text-gray-500 mb-1">Result:</p>
//               <pre className="text-xs text-gray-300 bg-gray-800 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
//                 {result}
//               </pre>
//             </div>
//           )}
//         </div>
//       )}
//     </div>
//   );
// }

function MessageBubble({ msg, isLatest }: { msg: Message; isLatest: boolean }) {
  if (msg.role === "tool_use") {
    // Hide tool calls from display
    return null;
  }

  if (msg.role === "tool_result") {
    // Already rendered with tool_use, skip
    return null;
  }

  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  
  // Enable typewriter only for the latest assistant message
  const { displayedText, isComplete } = useTypewriter(
    msg.content,
    15,
    isAssistant && isLatest
  );

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-6 animate-fade-in`}>
      <div className="flex items-start gap-3 max-w-[80%]">
        {/* Avatar */}
        {!isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
        )}
        
        <div
          className={`px-5 py-3.5 rounded-2xl shadow-md transition-all ${
            isUser
              ? "bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-br-sm"
              : "bg-gray-800/90 backdrop-blur-sm text-gray-100 rounded-tl-sm border border-gray-700/50"
          }`}
        >
          {isUser ? (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
          ) : (
            <div className="markdown-content text-[15px] leading-relaxed">
              <ReactMarkdown>{displayedText}</ReactMarkdown>
              {!isComplete && (
                <span className="inline-block w-1.5 h-4 bg-blue-500 ml-0.5 animate-pulse"></span>
              )}
            </div>
          )}
        </div>
        
        {isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center shadow-lg">
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
    <form onSubmit={handleSubmit} className="border-t border-gray-800/50 p-4 bg-gray-900/50 backdrop-blur-sm">
      <div className="max-w-3xl mx-auto flex items-end gap-3 bg-gray-800/60 rounded-2xl px-5 py-3.5 border border-gray-700/50 focus-within:border-blue-500/50 focus-within:shadow-lg focus-within:shadow-blue-500/10 transition-all">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Ask AIDA anything about your data..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-white text-[15px] resize-none outline-none placeholder-gray-400 max-h-[200px] leading-relaxed"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="p-2.5 bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed rounded-xl transition-all shadow-md hover:shadow-lg disabled:shadow-none flex-shrink-0"
          aria-label="Send message"
        >
          {disabled ? (
            <svg className="w-5 h-5 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
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
      <p className="text-xs text-gray-500 text-center mt-2">Press Enter to send, Shift+Enter for new line</p>
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
      <div className="flex-1 flex flex-col h-full bg-gradient-to-b from-gray-900 via-gray-900 to-gray-800">
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-2xl">
            <div className="mb-6 inline-block p-4 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-2xl">
              <svg className="w-16 h-16 text-blue-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-4">
              AIDA
            </h1>
            <p className="text-gray-400 text-lg mb-8">
              Advanced Insights & Decision Acceleration, centralized in-house data insights assistant
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
              <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-xl p-4">
                <div className="text-blue-400 mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <h3 className="text-white font-semibold mb-1">Sales Analytics</h3>
                <p className="text-gray-400 text-sm">Query booking trends and revenue data</p>
              </div>
              <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-xl p-4">
                <div className="text-purple-400 mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                </div>
                <h3 className="text-white font-semibold mb-1">Customer Insights</h3>
                <p className="text-gray-400 text-sm">Analyze guest behavior and preferences</p>
              </div>
              <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-xl p-4">
                <div className="text-green-400 mb-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                </div>
                <h3 className="text-white font-semibold mb-1">Property Data</h3>
                <p className="text-gray-400 text-sm">Explore funnel stages and conversions</p>
              </div>
            </div>
          </div>
        </div>
        <ChatInput onSend={handleSend} disabled={sending} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-gradient-to-b from-gray-900 via-gray-900 to-gray-800">
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
          {sending && (
            <div className="flex justify-start mb-6 animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div className="bg-gray-800/90 backdrop-blur-sm border border-gray-700/50 rounded-2xl rounded-tl-sm px-5 py-3.5 shadow-md">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    <span className="text-gray-400 text-sm ml-2">Thinking...</span>
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
