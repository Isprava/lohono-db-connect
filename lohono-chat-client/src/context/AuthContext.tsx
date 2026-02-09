import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { auth as authApi, type UserPublic } from "../api";

const AUTH_APP_URL = "https://auth.lohono.com";

interface AuthState {
  user: UserPublic | null;
  token: string | null;
  loading: boolean;
  loginWithGoogle: (userProfile: string) => Promise<void>;
  logout: () => void;
  /** Redirect to auth.lohono.com to start the OAuth flow */
  redirectToLogin: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function getCallbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem("token");
    const savedUser = localStorage.getItem("user");
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
      setLoading(false);
      // Verify session is still valid in background
      authApi
        .me()
        .then((u) => {
          setUser(u);
          localStorage.setItem("user", JSON.stringify(u));
        })
        .catch((err) => {
          // Only clear session if it's actually invalid (401)
          if (err.message === "Unauthorized") {
            localStorage.removeItem("token");
            localStorage.removeItem("user");
            setToken(null);
            setUser(null);
          }
          // Otherwise, keep the cached session (network error, server down, etc.)
        });
    } else {
      setLoading(false);
    }
  }, []);

  const loginWithGoogle = async (userProfile: string) => {
    const result = await authApi.google(userProfile);
    localStorage.setItem("token", result.token);
    localStorage.setItem("user", JSON.stringify(result.user));
    setToken(result.token);
    setUser(result.user);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore — clearing local state regardless
    }
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken(null);
    setUser(null);
  };

  const redirectToLogin = () => {
    const callbackUrl = getCallbackUrl();
    window.location.href = `${AUTH_APP_URL}/?redirect_url=${encodeURIComponent(callbackUrl)}`;
  };

  return (
    <AuthContext.Provider
      value={{ user, token, loading, loginWithGoogle, logout, redirectToLogin }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
