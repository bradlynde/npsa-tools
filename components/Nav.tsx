"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  BriefcaseBusiness,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  ScanSearch,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useSidebar, useTheme, type ThemePref } from "../lib/theme";

type NavItem = {
  href: string;
  label: string;
  /** One-word name for the phone tab bar, where five tabs share the width. */
  short: string;
  icon: LucideIcon;
  match: (p: string) => boolean;
};

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", short: "Home", icon: LayoutDashboard, match: (p) => p === "/" },
  {
    href: "/toolbox",
    label: "Sales Toolbox",
    short: "Toolbox",
    icon: BriefcaseBusiness,
    // The letter app is reached from the toolbox, so it keeps the item lit.
    match: (p) => p.startsWith("/toolbox") || p.startsWith("/loe"),
  },
  {
    href: "/grant-writing",
    label: "Grant Writing",
    short: "Writing",
    icon: PenLine,
    match: (p) => p.startsWith("/grant-writing"),
  },
  {
    href: "/grant-knowledge",
    label: "Grant Knowledge",
    short: "Knowledge",
    icon: BookOpenText,
    match: (p) => p.startsWith("/grant-knowledge"),
  },
  {
    href: "/scraper",
    label: "Scraper",
    short: "Scraper",
    icon: ScanSearch,
    // /school and /church remain as deep links into run details.
    match: (p) => p.startsWith("/scraper") || p.startsWith("/school") || p.startsWith("/church"),
  },
];

const THEMES: { key: ThemePref; label: string; icon: LucideIcon }[] = [
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "system", label: "Match system", icon: Monitor },
];

function Logo({ height }: { height: number }) {
  const width = Math.round((height * 389) / 122);
  return (
    <span className="brand-word">
      <img className="logo-light" src="/npsa-logo-t.png" alt="Nonprofit Security Advisors" width={width} height={height} style={{ height, width }} />
      <img className="logo-dark" src="/npsa-logo-dark.png" alt="Nonprofit Security Advisors" width={width} height={height} style={{ height, width }} />
    </span>
  );
}

function Mark({ height }: { height: number }) {
  const width = Math.round((height * 171) / 139);
  return (
    <span className="brand-mark">
      <img className="logo-light" src="/npsa-mark.png" alt="NPSA" width={width} height={height} style={{ height, width }} />
      <img className="logo-dark" src="/npsa-mark-dark.png" alt="NPSA" width={width} height={height} style={{ height, width }} />
    </span>
  );
}

/**
 * The account menu: who is signed in, the theme, and sign out. The sidebar
 * opens it upward from its foot; the phone header opens it downward.
 */
function AccountMenu({
  placement,
  onClose,
}: {
  placement: "up" | "down";
  onClose: () => void;
}) {
  const { username, logout } = useAuth();
  const [pref, setPref] = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[role^=menuitem]");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") || []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next]?.focus();
        e.preventDefault();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Account"
      className="menu"
      style={placement === "up" ? { bottom: "calc(100% + 8px)", left: 0 } : { top: "calc(100% + 8px)", right: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px 10px" }}>
        <span className="avatar">{(username || "?").charAt(0).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600, color: "var(--ink)" }}>{username || "Signed in"}</div>
          <div style={{ fontSize: 12, lineHeight: "16px", color: "var(--mute)" }}>Nonprofit Security Advisors</div>
        </div>
      </div>
      <div className="menu-sep" />
      <div className="menu-label">Theme</div>
      {THEMES.map((t) => (
        <button
          key={t.key}
          type="button"
          role="menuitemradio"
          aria-checked={pref === t.key}
          className="menu-item"
          onClick={() => setPref(t.key)}
        >
          <t.icon size={16} strokeWidth={1.75} aria-hidden />
          <span style={{ flex: 1 }}>{t.label}</span>
          {pref === t.key && <Check size={16} strokeWidth={2} aria-hidden style={{ color: "var(--navy-ink)" }} />}
        </button>
      ))}
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); logout(); }}>
        <LogOut size={16} strokeWidth={1.75} aria-hidden />
        Sign out
      </button>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname() || "/";
  const { username } = useAuth();
  const [state, toggle] = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const collapsed = state === "collapsed";

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <aside className="sidebar" aria-label="Main">
      <Link href="/" className="sidebar-brand" aria-label="NPSA Tools home">
        <Logo height={40} />
        <Mark height={32} />
      </Link>

      <nav aria-label="Tools">
        <ul className="nav-list">
          {NAV.map((n) => {
            const on = n.match(pathname);
            return (
              <li key={n.href}>
                <Link href={n.href} className="nav-item" aria-current={on ? "page" : undefined} aria-label={collapsed ? n.label : undefined}>
                  <n.icon size={19} strokeWidth={1.75} aria-hidden />
                  <span className="nav-label">{n.label}</span>
                  <span className="rail-tip" aria-hidden>{n.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="nav-item"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen size={19} strokeWidth={1.75} aria-hidden /> : <PanelLeftClose size={19} strokeWidth={1.75} aria-hidden />}
          <span className="nav-label">Collapse</span>
          <span className="rail-tip" aria-hidden>Expand sidebar</span>
        </button>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="nav-item"
            style={{ width: "100%", height: 44, paddingLeft: 7 }}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Account: ${username || "signed in"}`}
          >
            <span className="avatar">{(username || "?").charAt(0).toUpperCase()}</span>
            <span className="nav-label" style={{ flex: 1, color: "var(--ink)" }}>{username || "Account"}</span>
            <ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden className="sidebar-hide" />
            <span className="rail-tip" aria-hidden>Account and theme</span>
          </button>
          {menuOpen && <AccountMenu placement="up" onClose={() => setMenuOpen(false)} />}
        </div>
      </div>
    </aside>
  );
}

/** Phone header: the logo and the account menu, which holds sign-out and the theme. */
export function MobileHeader() {
  const pathname = usePathname() || "/";
  const { username } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <header className="mobile-header">
      <Link href="/" aria-label="NPSA Tools home" style={{ display: "flex", alignItems: "center" }}>
        <Logo height={30} />
      </Link>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Account: ${username || "signed in"}`}
          className="btn btn-quiet"
          style={{ width: 44, height: 44, padding: 0 }}
        >
          <span className="avatar" style={{ width: 32, height: 32, fontSize: 13 }}>{(username || "?").charAt(0).toUpperCase()}</span>
        </button>
        {menuOpen && <AccountMenu placement="down" onClose={() => setMenuOpen(false)} />}
      </div>
    </header>
  );
}

/** Bottom tab bar for phones. */
export function MobileTabs() {
  const pathname = usePathname() || "/";
  return (
    <nav className="mobile-tabs" aria-label="Tools">
      {NAV.map((n) => {
        const on = n.match(pathname);
        return (
          <Link key={n.href} href={n.href} className="mobile-tab" aria-current={on ? "page" : undefined}>
            <span className="mobile-tab-icon">
              <n.icon size={20} strokeWidth={on ? 2 : 1.75} aria-hidden />
            </span>
            {n.short}
          </Link>
        );
      })}
    </nav>
  );
}
