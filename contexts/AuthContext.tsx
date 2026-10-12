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
  /** Why the person was signed out, shown once on the sign-in screen (expired or refused sign-in). */
  notice: string | null;
  loading: boolean;
  authApiUrl: string; // Exposed for debugging
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Renew a sign-in at most this often while someone is using the toolbox, and
// wait this long before trying again after a renewal that didn't go through.
const RENEW_AFTER_MS = 12 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 15 * 60 * 1000;

const EXPIRED_NOTICE = "Your sign-in expired. Enter your email for a new code.";

/**
 * The claims in a sign-in token, read without checking the signature: only to
 * know when it lapses (`exp`) and when it was issued (`iat`). The backends are
 * what check the signature. Null when the token can't be read.
 */
function tokenClaims(token: string): { exp?: unknown; iat?: unknown } | null {
  try {
    let part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    while (part.length % 4) part += "=";
    return JSON.parse(atob(part));
  } catch {
    return null;
  }
}
const claimMs = (token: string, claim: "exp" | "iat"): number | null => {
  const v = tokenClaims(token)?.[claim];
  return typeof v === "number" ? v * 1000 : null;
};
/** When the sign-in lapses, in ms. Each renewal moves it on by the service's idle window. */
const tokenExpiresAt = (token: string) => claimMs(token, "exp");
/** When the token was issued, in ms. */
const tokenIssuedAt = (token: string) => claimMs(token, "iat");

/** The bearer token a fetch call carries, whichever way its headers were given. */
function bearerOf(input: RequestInfo | URL, init?: RequestInit): string | null {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const auth = headers.get("authorization");
  return auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : null;
}

/** Set by the signed-in provider; called with the bearer of any request refused with 401. */
let onRefused: ((bearer: string) => void) | null = null;
if (typeof window !== "undefined" && !(window as unknown as { __npsaFetchWatch?: boolean }).__npsaFetchWatch) {
  (window as unknown as { __npsaFetchWatch?: boolean }).__npsaFetchWatch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (res.status === 401 && onRefused) {
      const bearer = bearerOf(input, init);
      if (bearer) onRefused(bearer);
    }
    return res;
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const logout = React.useCallback(() => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_username");
      localStorage.removeItem("auth_last_activity"); // left by the old inactivity timer
    }
    setToken(null);
    setUsername(null);
    setIsAuthenticated(false);
  }, []);

  /** Sign out because the sign-in no longer works, and say why on the sign-in screen. */
  const expire = React.useCallback(() => {
    logout();
    setNotice(EXPIRED_NOTICE);
  }, [logout]);

  // Pick up a saved sign-in, unless it has already lapsed.
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedToken = localStorage.getItem("auth_token");
      const storedUsername = localStorage.getItem("auth_username");
      if (storedToken && storedUsername) {
        const expiresAt = tokenExpiresAt(storedToken);
        if (expiresAt !== null && expiresAt <= Date.now()) {
          localStorage.removeItem("auth_token");
          localStorage.removeItem("auth_username");
          localStorage.removeItem("auth_last_activity");
          setNotice(EXPIRED_NOTICE);
        } else {
          setToken(storedToken);
          setUsername(storedUsername);
          setIsAuthenticated(true);
        }
      }
    }
    setLoading(false);
  }, []);

  // Sign out when the sign-in lapses, rather than leaving every page to fail. A
  // timer can fire late after the computer sleeps, so check again on return too.
  useEffect(() => {
    if (!token) return;
    const expiresAt = tokenExpiresAt(token);
    if (expiresAt === null) return;
    const check = () => { if (Date.now() >= expiresAt) expire(); };
    const timer = setTimeout(check, Math.min(Math.max(expiresAt - Date.now(), 0), 2 ** 31 - 1));
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [token, expire]);

  // Any request sent with this sign-in that comes back 401 means the service no
  // longer accepts it (lapsed, or the signing secret changed): sign out cleanly.
  // The fetch watcher itself is installed when this module loads (below), so it
  // also sees the requests pages make before this provider's effects run.
  useEffect(() => {
    if (!token) return;
    onRefused = (bearer) => { if (bearer === token) expire(); };
    return () => { onRefused = null; };
  }, [token, expire]);

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
   * Keep a sign-in alive while it is being used. The auth service issues each
   * token for its idle window (14 days by default); every so often, when the
   * person is active here, swap the token for a fresh one, so the window counts
   * from the last time they used the toolbox. Someone away longer than the
   * window signs in again. A failure other than a refusal is left for next time.
   */
  const renewing = React.useRef(false);
  const lastTry = React.useRef(0);
  const renew = React.useCallback(async (current: string) => {
    const issuedAt = tokenIssuedAt(current);
    if (renewing.current || issuedAt === null || Date.now() - issuedAt < RENEW_AFTER_MS || Date.now() - lastTry.current < RETRY_AFTER_MS) return;
    renewing.current = true;
    lastTry.current = Date.now();
    try {
      const res = await postAuth("refresh", { token: current });
      if (res.status === 401) { expire(); return; }
      if (!res.ok) return; // the service is down or older than this: try again later
      const data = await res.json().catch(() => null);
      if (!data?.token || localStorage.getItem("auth_token") !== current) return;
      localStorage.setItem("auth_token", data.token);
      if (data.username) localStorage.setItem("auth_username", data.username);
      setToken(data.token);
    } catch {
      /* offline or timed out: try again later */
    } finally {
      renewing.current = false;
    }
    // postAuth only reads the service URL, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expire]);

  useEffect(() => {
    if (!token) return;
    renew(token);
    const events = ["mousedown", "keydown", "touchstart"];
    const onActivity = () => renew(token);
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity));
  }, [token, renew]);

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
    }
    setToken(data.token);
    setUsername(data.username);
    setIsAuthenticated(true);
    setNotice(null);
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
        notice,
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
