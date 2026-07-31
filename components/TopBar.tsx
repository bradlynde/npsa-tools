"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

const NAV = [
  { href: "/", label: "Dashboard", match: (p: string) => p === "/" },
  {
    href: "/toolbox",
    label: "Sales Toolbox",
    // The LOE app is reached from the toolbox, so it keeps the tab lit.
    match: (p: string) => p.startsWith("/toolbox") || p.startsWith("/loe"),
  },
  {
    href: "/scraper",
    label: "Scraper",
    // /school and /church remain as deep links into run details.
    match: (p: string) =>
      p.startsWith("/scraper") || p.startsWith("/school") || p.startsWith("/church"),
  },
];

/** Half-filled circle — the ◐/◑ glyphs aren't in IBM Plex Mono, so draw it. */
function HalfMoon({ flipped }: { flipped: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d={flipped ? "M6 .75A5.25 5.25 0 016 11.25z" : "M6 .75A5.25 5.25 0 006 11.25z"}
        fill="currentColor"
      />
    </svg>
  );
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.body.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !document.body.classList.contains("dark");
    document.body.classList.toggle("dark", next);
    try {
      localStorage.setItem("npsa-theme", next ? "dark" : "light");
    } catch {
      /* private mode — theme just won't persist */
    }
    setDark(next);
  };
  return [dark, toggle];
}

export default function TopBar() {
  const pathname = usePathname() || "/";
  const isMobile = useIsMobile();
  const [dark, toggleTheme] = useTheme();
  const { username, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the user menu on navigation.
  useEffect(() => setMenuOpen(false), [pathname]);

  const initial = (username || "?").charAt(0).toUpperCase();

  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: isMobile ? "12px 18px" : "16px 40px",
          borderBottom: "1px solid var(--hair)",
          background: "var(--bg)",
          position: "sticky",
          top: 0,
          zIndex: 20,
          flexWrap: "wrap",
        }}
      >
        <Link href="/" style={{ display: "inline-flex", alignItems: "center" }} aria-label="NPSA home">
          <Image
            src="/npsa-logo-t.png"
            alt="Nonprofit Security Advisors"
            width={170}
            height={40}
            priority
            style={{ height: 40, width: "auto", display: "block", filter: "var(--logo-filter)" }}
          />
        </Link>

        {!isMobile && (
          <>
            <nav style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
              {NAV.map((n) => {
                const on = n.match(pathname);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="mono"
                    aria-current={on ? "page" : undefined}
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      padding: "8px 18px",
                      borderRadius: 999,
                      textDecoration: "none",
                      transition: "background .2s, color .2s",
                      background: on ? "var(--navy)" : "transparent",
                      color: on ? "var(--on-accent)" : "var(--sec)",
                    }}
                    onMouseEnter={(e) => {
                      if (!on) e.currentTarget.style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!on) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>

            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 10,
                paddingLeft: 22,
                borderLeft: "1px solid var(--hair)",
              }}
            >
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                }}
              >
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: "var(--navycard)",
                    color: "#fff",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {initial}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--sec)" }}>
                  {username || "User"}
                </span>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 10,
                    background: "var(--card)",
                    border: "1px solid var(--bd)",
                    borderRadius: 12,
                    boxShadow: "var(--shadow-card-hover)",
                    overflow: "hidden",
                    zIndex: 50,
                    minWidth: 150,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      logout();
                      setMenuOpen(false);
                    }}
                    style={{
                      width: "100%",
                      padding: "11px 16px",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      font: "inherit",
                      fontSize: 13.5,
                      color: "var(--sec)",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={toggleTheme}
          title="Toggle dark mode"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="mono"
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "var(--sec)",
            background: "transparent",
            border: "1px solid var(--bd2)",
            borderRadius: 999,
            padding: "8px 14px",
            cursor: "pointer",
            transition: "background .2s",
            marginLeft: isMobile ? "auto" : 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <HalfMoon flipped={dark} />
            {dark ? "light" : "dark"}
          </span>
        </button>
      </header>

    </>
  );
}

/**
 * Bottom tab bar for mobile. Rendered by AppShell *after* <main> so it sits at
 * the foot of the column and stays pinned there while the page scrolls.
 */
export function MobileTabs() {
  const pathname = usePathname() || "/";
  const isMobile = useIsMobile();
  if (!isMobile) return null;

  return (
    // Fixed, not sticky: `overflow-x: hidden` on <body> makes it a scroll
    // container, which breaks sticky pinning. globals.css reserves the matching
    // space with a bottom padding on <main> under 760px.
    <nav
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        borderTop: "1px solid var(--hair)",
        background: "var(--card)",
        padding: "9px 6px 20px",
        zIndex: 20,
      }}
    >
      {NAV.map((n) => {
        const on = n.match(pathname);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={on ? "page" : undefined}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 5,
              textDecoration: "none",
              padding: "4px 0",
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: 7,
                transition: "all .2s",
                background: on ? "var(--navy)" : "transparent",
                border: on ? "2px solid var(--navy)" : "2px solid var(--bd2)",
              }}
            />
            <span
              className="mono"
              style={{ fontWeight: 600, fontSize: 10, color: on ? "var(--navy)" : "var(--mute)" }}
            >
              {n.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
