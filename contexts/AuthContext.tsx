"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

// Resolve auth API URL once (env vars are baked in at build time)
function getAuthApiUrl(): string {
  let url = process.env.NEXT_PUBLIC_AUTH_API_URL || process.env.NEXT_PUBLIC_SCHOOL_API_URL || "https://npsa-scraper.up.railway.app";
  url = url.replace(/\/+$/, "");
  if (!url.match(/^https?:\/\//)) url = `https://${url}`;
  return url;
}

interface AuthContextType {
  isAuthenticated: boolean;
  username: string | null;
  token: string | null;
  requestCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<boolean>;
  logout: () => void;
  loading: boolean;
  authApiUrl: string; // Exposed for debugging
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Update last activity timestamp
  const updateLastActivity = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("auth_last_activity", Date.now().toString());
    }
  };

  const logout = React.useCallback(() => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_username");
      localStorage.removeItem("auth_last_activity");
    }
    setToken(null);
    setUsername(null);
    setIsAuthenticated(false);
  }, []);

  // Check for existing token on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedToken = localStorage.getItem("auth_token");
      const storedUsername = localStorage.getItem("auth_username");
      const lastActivityStr = localStorage.getItem("auth_last_activity");
      
      if (storedToken && storedUsername) {
        // Check if 7 days have passed since last activity
        if (lastActivityStr) {
          const lastActivity = parseInt(lastActivityStr, 10);
          const now = Date.now();
          const daysSinceActivity = (now - lastActivity) / (24 * 60 * 60 * 1000);
          
          if (daysSinceActivity >= 7) {
            // Auto-logout - 7 days of inactivity
            localStorage.removeItem("auth_token");
            localStorage.removeItem("auth_username");
            localStorage.removeItem("auth_last_activity");
            setLoading(false);
            return;
          }
        }
        
        // Verify token is still valid (basic check - backend will verify)
        setToken(storedToken);
        setUsername(storedUsername);
        setIsAuthenticated(true);
        
        // Update last activity on successful mount
        updateLastActivity();
      }
    }
    setLoading(false);
  }, []);

  // Check for auto-logout periodically (every hour)
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const checkAutoLogout = () => {
      if (typeof window !== "undefined") {
        const lastActivityStr = localStorage.getItem("auth_last_activity");
        if (lastActivityStr) {
          const lastActivity = parseInt(lastActivityStr, 10);
          const now = Date.now();
          const daysSinceActivity = (now - lastActivity) / (24 * 60 * 60 * 1000);
          
          if (daysSinceActivity >= 7) {
            // Auto-logout after 7 days of inactivity
            logout();
          }
        }
      }
    };
    
    const interval = setInterval(checkAutoLogout, 60 * 60 * 1000); // Check every hour
    
    return () => clearInterval(interval);
  }, [isAuthenticated, logout]);

  // Update last activity on user interactions (mouse clicks, keyboard, etc.)
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    const handleActivity = () => {
      updateLastActivity();
    };
    
    events.forEach(event => {
      window.addEventListener(event, handleActivity, { passive: true });
    });
    
    return () => {
      events.forEach(event => {
        window.removeEventListener(event, handleActivity);
      });
    };
  }, [isAuthenticated]);

  const authApiUrl = getAuthApiUrl();

  /**
   * Posts to a same-origin auth route, falling back to the service directly if
   * that route is missing or can't reach it: the auth service allows an exact
   * list of origins, which never includes a Vercel preview's hostname.
   */
  const postAuth = async (path: string, payload: unknown): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      let response = await fetch(`/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => null);

      if (!response || response.status === 404 || response.status === 502) {
        response = await fetch(`${authApiUrl}/auth/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      }
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  /**
   * Ask for a sign-in code. Resolves whether or not the address belongs to
   * anyone — the service answers identically either way on purpose, so there is
   * nothing here to report back.
   */
  const requestCode = async (email: string): Promise<void> => {
    let res: Response;
    try {
      res = await postAuth("request-code", { email: email.trim().toLowerCase() });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error("The sign-in service didn’t respond in time. Try again in a moment.");
      }
      throw new Error("Can’t reach the sign-in service. It may be starting up — try again shortly.");
    }
    // 422 is the service rejecting the address as malformed; everything else
    // that isn't OK is ours, not the user's.
    if (res.status === 422) throw new Error("That doesn’t look like a valid email address.");
    if (!res.ok) throw new Error("Couldn’t send a code just now. Try again in a moment.");
  };

  const verifyCode = async (email: string, code: string): Promise<boolean> => {
    let res: Response;
    try {
      res = await postAuth("verify-code", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error("The sign-in service didn’t respond in time. Try again in a moment.");
      }
      throw new Error("Can’t reach the sign-in service. It may be starting up — try again shortly.");
    }

    if (res.status === 429) {
      throw new Error("Too many attempts. Wait a few minutes and request a new code.");
    }
    if (!res.ok) return false; // wrong, expired, or already used — all the same to us

    const data = await res.json().catch(() => null);
    if (!data || data.status !== "success" || !data.token) return false;

    if (typeof window !== "undefined") {
      localStorage.setItem("auth_token", data.token);
      localStorage.setItem("auth_username", data.username);
      updateLastActivity();
    }
    setToken(data.token);
    setUsername(data.username);
    setIsAuthenticated(true);
    return true;
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        username,
        token,
        requestCode,
        verifyCode,
        logout,
        loading,
        authApiUrl,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
