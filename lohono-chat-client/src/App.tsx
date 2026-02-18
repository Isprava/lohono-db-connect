import { useState, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import AdminPage from "./pages/AdminPage";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";

// ── Protected route wrapper ────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth/callback" replace />;
  return <>{children}</>;
}

// ── Main chat layout ───────────────────────────────────────────────────────

function ChatLayout() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refreshSidebar = useCallback(() => {
    setRefreshTrigger((n) => n + 1);
  }, []);

  const handleNewChat = () => {
    setActiveSessionId(null);
    setSidebarOpen(false);
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setSidebarOpen(false);
  };

  const handleSessionCreated = (id: string) => {
    setActiveSessionId(id);
    refreshSidebar();
  };

  return (
    <div className="flex h-full relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        refreshTrigger={refreshTrigger}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <ChatView
        sessionId={activeSessionId}
        onSessionCreated={handleSessionCreated}
        onMenuClick={() => setSidebarOpen(true)}
      />
    </div>
  );
}

// ── Admin layout ──────────────────────────────────────────────────────────

function AdminLayout() {
  const { isAdmin } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="flex h-full relative">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewChat={() => {}}
        refreshTrigger={0}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex-1 flex flex-col">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-secondary/10 bg-white">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 text-text/60 hover:text-text hover:bg-surface rounded-lg transition-colors"
            aria-label="Open menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-semibold text-primary">Admin</span>
        </div>
        <AdminPage />
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <ChatLayout />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminLayout />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
