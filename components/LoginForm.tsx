"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

/**
 * Sign in with an emailed code.
 *
 * Two steps: address, then the six digits sent to it. The second step never
 * confirms whether the address was recognised — the service answers the same
 * either way, and saying "we sent it" regardless is what makes that true from
 * the outside. Someone typing a wrong address finds out at the code step, which
 * costs them one retry and tells an outsider nothing.
 */
export default function LoginForm() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const { requestCode, verifyCode } = useAuth();

  // The service won't send another code for a minute, so don't offer to.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const send = async (resending = false) => {
    setError(null);
    setNote(null);
    setLoading(true);
    try {
      await requestCode(email);
      setStep("code");
      setCooldown(60);
      if (resending) setNote("A new code is on its way.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const submitEmail = (e: React.FormEvent) => {
    e.preventDefault();
    void send();
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    setLoading(true);
    try {
      const ok = await verifyCode(email, code);
      if (!ok) {
        setError("That code isn’t right, or it has expired. Check the latest email, or send a new code.");
        setCode("");
        codeRef.current?.focus();
      }
      // On success the provider flips isAuthenticated and this screen unmounts.
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--sec)",
    marginBottom: 6,
  };

  const fieldStyle: React.CSSProperties = { height: 44, fontSize: 15 };

  const linkButton: React.CSSProperties = {
    fontSize: 13,
    lineHeight: "18px",
    fontWeight: 500,
    color: "var(--navy)",
    background: "none",
    border: "none",
    padding: "4px 0",
    cursor: "pointer",
  };

  const codeReady = code.length === 6;

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--bg)",
        padding: "0 16px",
      }}
    >
      <div
        className="fade-up"
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 400,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "48px 0 32px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <img className="logo-light" src="/npsa-logo-t.png" alt="Nonprofit Security Advisors" width={153} height={48} style={{ height: 48, width: "auto" }} />
          <img className="logo-dark" src="/npsa-logo-dark.png" alt="Nonprofit Security Advisors" width={153} height={48} style={{ height: 48, width: "auto" }} />
        </div>

        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 className="headline" style={{ fontSize: 28, lineHeight: "36px" }}>
            {step === "email" ? "Sign in to NPSA Tools" : "Check your email"}
          </h1>
          <p style={{ fontSize: 14, lineHeight: "20px", color: "var(--sec)", marginTop: 6 }}>
            {step === "email" ? (
              "We’ll email you a six-digit code. No password needed."
            ) : (
              <>
                If <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{email}</strong> is set up for the
                tools, a code is on its way. It expires in 10 minutes.
              </>
            )}
          </p>
        </div>

        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--bd2)",
            borderRadius: "var(--r-lg)",
            boxShadow: "var(--shadow-card)",
            padding: 24,
          }}
        >
          {step === "email" ? (
            <form onSubmit={submitEmail}>
              <div style={{ marginBottom: 16 }}>
                <label htmlFor="login-email" style={labelStyle}>
                  Work email
                </label>
                <input
                  id="login-email"
                  type="email"
                  className="field"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="you@nonprofitsecurityadvisors.com"
                  style={fieldStyle}
                />
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}

              <button type="submit" disabled={loading} aria-busy={loading || undefined} className="btn btn-primary btn-lg btn-block">
                {loading ? "Sending…" : "Send code"}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <div style={{ marginBottom: 16 }}>
                <label htmlFor="login-code" style={labelStyle}>
                  Six-digit code
                </label>
                <input
                  ref={codeRef}
                  id="login-code"
                  // "text" with a numeric mode: type="number" gives spinners
                  // and drops leading zeros, which every code can start with.
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  className="field mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required
                  autoComplete="one-time-code"
                  placeholder="000000"
                  style={{
                    height: 52,
                    fontSize: 24,
                    letterSpacing: ".38em",
                    textAlign: "center",
                    paddingLeft: "calc(12px + .38em)",
                  }}
                />
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}
              {note && (
                <p role="status" style={{ fontSize: 13, lineHeight: "18px", color: "var(--ok-fg)", margin: "0 0 14px" }}>{note}</p>
              )}

              <button
                type="submit"
                disabled={loading || !codeReady}
                aria-busy={loading || undefined}
                className="btn btn-primary btn-lg btn-block"
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  marginTop: 14,
                }}
              >
                <button
                  type="button"
                  style={linkButton}
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                    setNote(null);
                  }}
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  disabled={cooldown > 0 || loading}
                  style={{
                    ...linkButton,
                    color: cooldown > 0 ? "var(--mute)" : "var(--navy)",
                    cursor: cooldown > 0 ? "default" : "pointer",
                  }}
                  onClick={() => void send(true)}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, lineHeight: "16px", color: "var(--mute)", padding: "0 0 24px", textAlign: "center" }}>
        Nonprofit Security Advisors · internal tools
      </p>
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: "10px 12px",
        background: "var(--err-bg)",
        border: "1px solid var(--err-line)",
        borderRadius: "var(--r-md)",
        marginBottom: 16,
      }}
    >
      <p
        style={{
          color: "var(--err-fg)",
          fontSize: 13,
          fontWeight: 500,
          margin: 0,
          whiteSpace: "pre-line",
          lineHeight: 1.5,
        }}
      >
        {children}
      </p>
    </div>
  );
}
