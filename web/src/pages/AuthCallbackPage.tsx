import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function AuthCallbackPage() {
  const { loginWithGoogle, redirectToLogin, user } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    // Already authenticated — go home
    if (user) {
      navigate("/", { replace: true });
      return;
    }

    // Check if we have a token in localStorage (user might have just refreshed the page)
    const savedToken = localStorage.getItem("token");
    if (savedToken) {
      // User has a saved session, redirect to home and let AuthContext validate it
      navigate("/", { replace: true });
      return;
    }

    const userProfile = searchParams.get("userProfile");

    if (!userProfile) {
      // No profile in URL and no saved token — redirect to auth.lohono.com to start OAuth
      redirectToLogin();
      return;
    }

    // Exchange the Google profile for a session token
    if (processing) return;
    setProcessing(true);

    loginWithGoogle(userProfile)
      .then(() => {
        navigate("/", { replace: true });
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Authentication failed"
        );
      })
      .finally(() => setProcessing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
        <div className="w-full max-w-md text-center">
          <div className="bg-gray-800 rounded-xl p-8 shadow-2xl border border-gray-700">
            <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm">
              {error}
            </div>
            <button
              onClick={() => redirectToLogin()}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400">Authenticating...</p>
      </div>
    </div>
  );
}
