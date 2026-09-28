"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "../contexts/AuthContext";
import LoginForm from "./LoginForm";
import { MobileHeader, MobileTabs, Sidebar } from "./Nav";
import { useSystemThemeSync } from "../lib/theme";
import { rememberSection, sectionOf } from "../lib/landing";

/** Routes that hand the whole content area to the embedded Sales Toolbox app. */
const FRAME_ROUTES = ["/loe"];

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const pathname = usePathname() || "/";
  const framed = FRAME_ROUTES.some((r) => pathname.startsWith(r));

  // Remember the section, so the next visit to "/" opens here (lib/landing.ts).
  useEffect(() => {
    if (!isAuthenticated) return;
    const section = sectionOf(pathname);
    if (section) document.cookie = rememberSection(section);
  }, [pathname, isAuthenticated]);

  // The session check is a localStorage read, so this shows for a frame or two.
  // Draw the brand rather than a bare word.
  if (loading) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }} role="status" aria-label="Loading">
        <span className="brand-mark" style={{ opacity: 0.9 }}>
          <img className="logo-light" src="/npsa-mark.png" alt="" width={49} height={40} />
          <img className="logo-dark" src="/npsa-mark-dark.png" alt="" width={49} height={40} />
        </span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">
        <MobileHeader />
        {/* Padding/width live in <Page> (or in the legacy run screens' own wrappers),
            so nothing double-pads. */}
        <main className={framed ? "frame-main" : undefined}>{children}</main>
      </div>
      <MobileTabs />
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  useSystemThemeSync();
  return (
    <AuthProvider>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}
