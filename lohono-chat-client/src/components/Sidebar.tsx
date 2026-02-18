import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { sessions as sessionsApi, type Session } from "../api";
import { useAuth } from "../context/AuthContext";

interface SidebarProps {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  refreshTrigger: number;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  activeSessionId,
  onSelectSession,
  onNewChat,
  refreshTrigger,
  isOpen,
  onClose,
}: SidebarProps) {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sessionList, setSessionList] = useState<Session[]>([]);
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    sessionsApi.list().then(setSessionList).catch(console.error);
  }, [refreshTrigger]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await sessionsApi.delete(id);
    setSessionList((prev) => prev.filter((s) => s.sessionId !== id));
    if (activeSessionId === id) onNewChat();
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div
      className={`
        fixed inset-y-0 left-0 z-30 w-72 bg-primary border-r border-primary flex flex-col h-full
        transform transition-transform duration-300 ease-in-out
        lg:relative lg:translate-x-0
        ${isOpen ? "translate-x-0" : "-translate-x-full"}
      `}
    >
      {/* Mobile close button */}
      <div className="flex items-center justify-between p-3 lg:hidden">
        <span className="text-white/80 text-sm font-medium pl-2">Chats</span>
        <button
          onClick={onClose}
          className="p-2 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          aria-label="Close sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* New Chat */}
      <div className="p-3 pt-0 lg:pt-3">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-4 py-2.5 border border-white/20 rounded-lg text-white/80 hover:bg-white/10 transition-colors text-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessionList.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => onSelectSession(session.sessionId)}
            className={`w-full text-left px-3 py-2.5 rounded-lg mb-0.5 group flex items-center transition-colors ${
              activeSessionId === session.sessionId
                ? "bg-white/15 text-white"
                : "text-white/60 hover:bg-white/10 hover:text-white"
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{session.title}</div>
              <div className="text-xs text-white/40 mt-0.5">
                {formatDate(session.updatedAt)}
              </div>
            </div>
            <button
              onClick={(e) => handleDelete(e, session.sessionId)}
              className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-300 transition-all"
              title="Delete chat"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </button>
        ))}
        {sessionList.length === 0 && (
          <p className="text-center text-white/30 text-sm mt-8">
            No conversations yet
          </p>
        )}
      </div>

      {/* Data dump info */}
      <div className="border-t border-white/10 px-3 py-2">
        <p className="text-xs text-white/40 text-center">
          Data dump: 2026-02-08 14:09:50
        </p>
      </div>

      {/* Admin link */}
      {isAdmin && (
        <div className="border-t border-white/10 px-3 py-2">
          <button
            onClick={() => {
              navigate(location.pathname === "/admin" ? "/" : "/admin");
              onClose();
            }}
            className={`w-full flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
              location.pathname === "/admin"
                ? "bg-accent/20 text-accent"
                : "text-white/60 hover:bg-white/10 hover:text-white"
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {location.pathname === "/admin" ? "Back to Chat" : "Admin"}
          </button>
        </div>
      )}

      {/* User profile */}
      <div className="border-t border-white/10 p-3 relative">
        <button
          onClick={() => setShowProfile(!showProfile)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-sm font-medium text-primary">
            {user?.name?.charAt(0).toUpperCase() || "?"}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm text-white truncate">{user?.name}</div>
            <div className="text-xs text-white/50 truncate">{user?.email}</div>
          </div>
          <svg className="w-4 h-4 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01" />
          </svg>
        </button>

        {showProfile && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-primary border border-white/20 rounded-lg shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10">
              <p className="text-sm font-medium text-white">{user?.name}</p>
              <p className="text-xs text-white/60">{user?.email}</p>
            </div>
            <button
              onClick={logout}
              className="w-full px-4 py-2.5 text-left text-sm text-red-300 hover:bg-white/10 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
