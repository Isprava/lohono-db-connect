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
  isAdmin: boolean;
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
  const [isAdmin, setIsAdmin] = useState(false);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem("token");
    const savedUser = localStorage.getItem("user");
    if (savedToken && savedUser) {
      setToken(savedToken);
      const parsed = JSON.parse(savedUser);
      setUser(parsed);
      setIsAdmin(parsed.isAdmin === true);
      setLoading(false);
      // Refresh user profile in background; never clear the local
      // session here — individual API calls will handle 401 errors
      // when the user actually interacts.
      authApi
        .me()
        .then((u) => {
          setUser(u);
          setIsAdmin(u.isAdmin === true);
          localStorage.setItem("user", JSON.stringify(u));
        })
        .catch(() => {
          // Keep cached session regardless of error type.
          // If the token is truly expired, the next user-initiated
          // API call will surface a 401 and prompt re-login.
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
    setIsAdmin(result.user.isAdmin === true);
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
    setIsAdmin(false);
  };

  const redirectToLogin = () => {
    const callbackUrl = getCallbackUrl();
    window.location.href = `${AUTH_APP_URL}/?redirect_url=${encodeURIComponent(callbackUrl)}`;
  };

  return (
    <AuthContext.Provider
      value={{ user, token, loading, isAdmin, loginWithGoogle, logout, redirectToLogin }}
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
