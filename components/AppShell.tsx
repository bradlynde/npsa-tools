"use client";

import { AuthProvider, useAuth } from "../contexts/AuthContext";
import LoginForm from "./LoginForm";
import TopBar, { MobileTabs } from "./TopBar";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--mute)",
        }}
      >
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <TopBar />
      {/* Padding/width live in <Page> (or in the legacy run screens' own wrappers),
          so nothing double-pads. */}
      <main style={{ flex: 1, width: "100%" }}>{children}</main>
      <MobileTabs />
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
