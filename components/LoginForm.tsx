"use client";

import React, { useState } from "react";
import Image from "next/image";
import { useAuth } from "../contexts/AuthContext";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const success = await login(username, password);
      if (!success) {
        setError("That username and password don’t match. Try again.");
        setLoading(false);
      }
    } catch (err: unknown) {
      console.error("Login form error:", err);
      const raw = (err as Error)?.message || "Something went wrong signing in.";
      let message = raw;

      if (raw.startsWith("CONNECTION_FAILED:")) {
        const attempted = raw.replace("CONNECTION_FAILED:", "");
        message = `Can’t reach the sign-in service at ${attempted}. It may be starting up — wait a moment and try again.`;
      } else if (raw.includes("timed out")) {
        message = "The sign-in service didn’t respond in time. Try again in a moment.";
      }

      setError(message);
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
              Welcome <em>back.</em>
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
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 18 }}>
                <label className="mono" htmlFor="login-username" style={labelStyle}>
                  username
                </label>
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="username"
                  style={inputStyle}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--navy)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(30,58,95,0.12)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--bd2)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <label className="mono" htmlFor="login-password" style={labelStyle}>
                  password
                </label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  style={inputStyle}
                  onFocus={(e) => {
                    e.target.style.borderColor = "var(--navy)";
                    e.target.style.boxShadow = "0 0 0 3px rgba(30,58,95,0.12)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "var(--bd2)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>

              {error && (
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
                    {error}
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
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
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.transform = "translateY(-1px)";
                    e.currentTarget.style.boxShadow = "0 8px 20px rgba(30,58,95,.3)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "none";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
