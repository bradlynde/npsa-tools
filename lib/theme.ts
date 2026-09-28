"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Theme preference: light, dark, or whatever the computer is set to.
 *
 * The preference is stored under `npsa-theme`; the applied theme is the `dark`
 * class on <body>, which is what every token in globals.css and the Sales
 * Toolbox frame (see ToolFrame) key off. Nothing stored means "system".
 */
export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "npsa-theme";
export const SIDEBAR_KEY = "npsa-sidebar";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* private mode: fall through to the system setting */
  }
  return "system";
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(pref: ThemePref, animate: boolean) {
  const dark = pref === "dark" || (pref === "system" && systemDark());
  const body = document.body;
  if (body.classList.contains("dark") === dark) return;
  if (animate) {
    body.classList.add("theme-anim");
    window.setTimeout(() => body.classList.remove("theme-anim"), 300);
  }
  body.classList.toggle("dark", dark);
}

/**
 * While the preference is "system", follow the computer live: switching macOS
 * to dark at sunset switches the tools too. Mounted once, by AppShell, so it
 * runs whether or not the account menu is open.
 */
export function useSystemThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      if (readPref() === "system") apply("system", true);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    setPrefState(readPref());
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, p);
    } catch {
      /* private mode: the choice just won't persist */
    }
    setPrefState(p);
    apply(p, true);
  }, []);

  return [pref, setPref];
}

export type SidebarState = "expanded" | "collapsed";

export function useSidebar(): [SidebarState, () => void] {
  const [state, setState] = useState<SidebarState>("expanded");

  useEffect(() => {
    const html = document.documentElement;
    setState(html.dataset.sidebar === "collapsed" ? "collapsed" : "expanded");

    // With no saved choice, the rail follows the window: collapsed on
    // narrow screens, open on wide ones.
    const mq = window.matchMedia("(max-width: 1100px)");
    const on = () => {
      let saved: string | null = null;
      try { saved = localStorage.getItem(SIDEBAR_KEY); } catch { /* private mode */ }
      if (saved) return;
      const next: SidebarState = mq.matches ? "collapsed" : "expanded";
      html.dataset.sidebar = next;
      setState(next);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggle = useCallback(() => {
    const html = document.documentElement;
    const next: SidebarState = html.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
    html.classList.add("sidebar-anim");
    window.setTimeout(() => html.classList.remove("sidebar-anim"), 260);
    html.dataset.sidebar = next;
    try { localStorage.setItem(SIDEBAR_KEY, next); } catch { /* private mode */ }
    setState(next);
  }, []);

  return [state, toggle];
}
