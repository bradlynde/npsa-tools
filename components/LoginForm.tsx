"use client";

import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
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
    fontWeight: 500,
    fontSize: 11,
    letterSpacing: ".07em",
    color: "var(--mute)",
    marginBottom: 7,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    font: "inherit",
    fontSize: 15,
    padding: "13px 15px",
    background: "var(--card)",
    border: "1px solid var(--bd2)",
    borderRadius: 14,
    color: "var(--ink)",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color .2s, box-shadow .2s",
  };

  const focus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = "var(--navy)";
    e.target.style.boxShadow = "0 0 0 3px rgba(30,58,95,0.12)";
  };
  const blur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = "var(--bd2)";
    e.target.style.boxShadow = "none";
  };

  const primaryButton: React.CSSProperties = {
    width: "100%",
    font: "inherit",
    fontSize: 14,
    fontWeight: 700,
    padding: "14px 24px",
    borderRadius: 999,
    color: "var(--on-accent)",
    background: loading ? "var(--mute)" : "var(--navy)",
    border: "none",
    cursor: loading ? "not-allowed" : "pointer",
    transition: "transform .2s, box-shadow .2s, background .2s",
  };

  const quietButton: React.CSSProperties = {
    font: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--sec)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: 3,
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      <div style={{ padding: "22px 32px" }}>
        <Image
          src="/npsa-logo-t.png"
          alt="Nonprofit Security Advisors"
          width={170}
          height={40}
          priority
          style={{ height: 40, width: "auto", objectFit: "contain", filter: "var(--logo-filter)" }}
        />
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 18px 60px",
        }}
      >
        <div className="fade-up" style={{ width: "100%", maxWidth: 420 }}>
          <div style={{ marginBottom: 26 }}>
            <div
              className="mono"
              style={{
                fontWeight: 500,
                fontSize: 12,
                letterSpacing: ".08em",
                color: "var(--olive)",
                marginBottom: 9,
              }}
            >
              npsa tools
            </div>
            <h1 className="headline" style={{ fontSize: 34 }}>
              {step === "email" ? (
                <>
                  Welcome <em>back.</em>
                </>
              ) : (
                <>
                  Check your <em>email.</em>
                </>
              )}
            </h1>
          </div>

          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--bd)",
              borderRadius: 16,
              boxShadow: "var(--shadow-card)",
              padding: "28px 26px",
            }}
          >
            {step === "email" ? (
              <form onSubmit={submitEmail}>
                <div style={{ marginBottom: 18 }}>
                  <label className="mono" htmlFor="login-email" style={labelStyle}>
                    email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="you@nonprofitsecurityadvisors.com"
                    style={inputStyle}
                    onFocus={focus}
                    onBlur={blur}
                  />
                  <p style={{ fontSize: 12.5, color: "var(--mute)", margin: "9px 2px 0", lineHeight: 1.5 }}>
                    We’ll email you a six-digit code. No password needed.
                  </p>
                </div>

                {error && <ErrorNote>{error}</ErrorNote>}

                <button type="submit" disabled={loading} style={primaryButton}>
                  {loading ? "Sending…" : "Send Code"}
                </button>
              </form>
            ) : (
              <form onSubmit={submitCode}>
                <p style={{ fontSize: 13.5, color: "var(--sec)", margin: "0 0 18px", lineHeight: 1.6 }}>
                  If <strong style={{ color: "var(--ink)" }}>{email}</strong> is set up for the
                  toolbox, a six-digit code is on its way. It expires in 10 minutes.
                </p>

                <div style={{ marginBottom: 18 }}>
                  <label className="mono" htmlFor="login-code" style={labelStyle}>
                    code
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
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    required
                    autoComplete="one-time-code"
                    placeholder="000000"
                    style={{
                      ...inputStyle,
                      fontSize: 24,
                      letterSpacing: ".38em",
                      textAlign: "center",
                      fontFamily: "var(--font-mono, monospace)",
                    }}
                    onFocus={focus}
                    onBlur={blur}
                  />
                </div>

                {error && <ErrorNote>{error}</ErrorNote>}
                {note && (
                  <p style={{ fontSize: 12.5, color: "var(--ok-fg)", margin: "0 0 14px" }}>{note}</p>
                )}

                <button type="submit" disabled={loading || code.length < 6} style={{
                  ...primaryButton,
                  background: loading || code.length < 6 ? "var(--mute)" : "var(--navy)",
                  cursor: loading || code.length < 6 ? "not-allowed" : "pointer",
                }}>
                  {loading ? "Signing in…" : "Sign In"}
                </button>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    marginTop: 16,
                  }}
                >
                  <button
                    type="button"
                    style={quietButton}
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
                      ...quietButton,
                      color: cooldown > 0 ? "var(--faint)" : "var(--sec)",
                      cursor: cooldown > 0 ? "default" : "pointer",
                      textDecoration: cooldown > 0 ? "none" : "underline",
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
      </div>
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: "12px 14px",
        background: "var(--err-bg)",
        border: "1px solid var(--err-fg)",
        borderRadius: 12,
        marginBottom: 18,
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
