"use client";

import React, { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

/* ── Motion ─────────────────────────────────────────────────────── */

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drives a 0→1 progress value over `duration` with a cubic ease-out, restarting
 * whenever `key` changes. Always lands exactly on 1 so counters show true values.
 */
export function useRoll(key: unknown = 0, duration = 950): number {
  const [p, setP] = useState(prefersReducedMotion() ? 1 : 0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setP(1);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setP(1 - Math.pow(1 - t, 3));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setP(1);
    };
    setP(0);
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [key, duration]);

  return p;
}

/**
 * Live width of the referenced element; 0 until first measured.
 *
 * Charts decide how many axis labels fit from this rather than from a viewport
 * breakpoint — the same chart is a different width inside a full-bleed card than
 * it is in a two-column grid, and a breakpoint cannot tell them apart.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

export const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");
export const fmtMoney = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
export const fmtPct = (v: number) => `${Math.round(v)}%`;

/**
 * Sentence case for labels that arrive as data. Only all-lowercase strings are
 * touched ("primary" → "Primary"), so codes and names like "NSGP-S" pass through.
 */
export function sentence(v: React.ReactNode): React.ReactNode {
  if (typeof v !== "string" || !v || v !== v.toLowerCase()) return v;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/* Small text never goes below 12px, and olive text that small uses the darker
   olive ink so it still passes contrast. */
function labelStyle(color: string | undefined, style?: React.CSSProperties): React.CSSProperties {
  const fs = style?.fontSize;
  return {
    ...style,
    ...(color ? { color: color === "var(--olive)" ? "var(--olive-ink)" : color } : null),
    ...(typeof fs === "number" && fs < 12 ? { fontSize: 12 } : null),
  };
}

/* ── Layout ─────────────────────────────────────────────────────── */

/** Centered page frame — owns the max width and page padding. */
export function Page({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fade-up page"
      style={{ width: "100%", maxWidth: 1280, margin: "0 auto" }}
    >
      {children}
    </div>
  );
}

/* ── Surfaces ───────────────────────────────────────────────────── */

export function Card({
  children,
  style,
  hover = false,
  onClick,
  className,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  hover?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={["card-surface", hover ? "lift" : "", className || ""]
        .filter(Boolean)
        .join(" ")}
      style={{
        background: "var(--card)",
        border: "1px solid var(--bd2)",
        borderRadius: "var(--r-lg)",
        padding: "20px 24px",
        // The resting shadow lives in .card-surface, not here: an inline
        // box-shadow outranks .lift:hover. Callers can still override via `style`.
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Small sentence-case label that names the thing below it. */
export function Eyebrow({
  children,
  color = "var(--mute)",
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className="eyebrow" style={labelStyle(color, style)}>
      {children}
    </div>
  );
}

/**
 * Page title. Tool pages use a plain title with an optional description under
 * it; the Dashboard passes `hero` for its one line of voice. `em` inside the
 * title renders as the accent phrase.
 */
export function PageHeading({
  eyebrow,
  description,
  hero = false,
  children,
  style,
}: {
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  hero?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, ...style }}>
      {eyebrow && (
        <div className="eyebrow" style={{ color: "var(--olive-ink)" }}>
          {eyebrow}
        </div>
      )}
      <h1 className={hero ? "headline headline-hero" : "headline"}>{children}</h1>
      {description && (
        <p style={{ fontSize: 14, lineHeight: "20px", color: "var(--sec)", maxWidth: 640, margin: 0 }}>
          {description}
        </p>
      )}
    </div>
  );
}

/** Section title with optional meta and actions on the right. */
export function SectionHeader({
  title,
  meta,
  actions,
  style,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
        <h2 className="section-title">{title}</h2>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {actions && <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}

/* ── Stats ──────────────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  note,
  accent = false,
  delay = 0,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: boolean;
  delay?: number;
}) {
  // The entrance animation sits on a wrapper, not on the Card: `fadeUp` with
  // fill-mode `both` keeps its final transform applied for good, and an
  // animated property outranks a normal one in the cascade.
  return (
    <div style={{ animation: "fadeUp .4s ease both", animationDelay: `${delay}ms` }}>
      <Card style={{ padding: "18px 20px", height: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="eyebrow">{sentence(label)}</div>
        <div className="kpi" style={{ color: accent ? "var(--olive)" : "var(--ink)", fontSize: 34, lineHeight: "40px" }}>
          {value}
        </div>
        {note && <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--sec)" }}>{sentence(note)}</div>}
      </Card>
    </div>
  );
}

/* ── Controls ───────────────────────────────────────────────────── */

export type SegOption<T extends string> = { key: T; label: string };

/** Segmented control: switches the view. */
export function SegPill<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  label,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={size === "sm" ? "seg seg-sm" : "seg"}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={o.key === value}
          className="seg-btn"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Filter chips: narrow a list. */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="chips">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={o.key === value}
          className="chip"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "inverse";

/**
 * The one button. Primary for the main action on a screen, secondary for the
 * rest, quiet for low-stakes actions in dense places, danger for destructive
 * ones, inverse on a filled navy surface.
 */
export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  disabled,
  busy,
  type = "button",
  title,
  block,
  style,
  className,
  ...aria
}: {
  children?: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  title?: string;
  block?: boolean;
  style?: React.CSSProperties;
  className?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu" | "dialog" | true;
}) {
  const iconSize = size === "sm" ? 15 : 16;
  const cls = [
    "btn",
    `btn-${variant}`,
    size !== "md" ? `btn-${size}` : "",
    !children ? "btn-icon" : "",
    block ? "btn-block" : "",
    className || "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={title}
      className={cls}
      style={style}
      {...aria}
    >
      {busy ? <Spinner size={iconSize} /> : Icon ? <Icon size={iconSize} strokeWidth={1.75} aria-hidden /> : null}
      {children}
      {IconRight && <IconRight size={iconSize} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}

/** Kept for existing call sites; renders the shared Button. */
export function PillButton({
  children,
  onClick,
  tone = "navy",
  disabled,
  type = "button",
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: "navy" | "olive" | "outline" | "white";
  disabled?: boolean;
  type?: "button" | "submit";
  style?: React.CSSProperties;
}) {
  const variant: ButtonVariant =
    tone === "outline" ? "secondary" : tone === "white" ? "inverse" : "primary";
  return (
    <Button variant={variant} onClick={onClick} disabled={disabled} type={type} style={style}>
      {children}
    </Button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderRightColor: "transparent",
        display: "inline-block",
        animation: "spin .7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

/* ── Status ─────────────────────────────────────────────────────── */

export type StatusTone = "running" | "queued" | "done" | "error" | "warn";

const BADGE_TONE: Record<StatusTone, string> = {
  running: "badge-run",
  queued: "badge-neutral",
  done: "badge-ok",
  error: "badge-err",
  warn: "badge-warn",
};

/** Status badge: tone plus a dot, so status never rests on color alone. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return <span className={`badge badge-dot ${BADGE_TONE[tone]}`}>{sentence(children)}</span>;
}

/** Outlined tag for a type or category (School, Church, Primary). */
export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="badge badge-outline">{sentence(children)}</span>;
}

/** Live indicator: solid dot + expanding ping ring. */
export function Pulse({ color = "var(--olive)" }: { color?: string }) {
  return (
    <span
      style={{ position: "relative", width: 8, height: 8, flexShrink: 0, display: "inline-block" }}
      aria-hidden="true"
    >
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: color,
          animation: "ping 1.6s ease-out infinite",
        }}
      />
    </span>
  );
}

/** Horizontal bar on a track, grown in from the left. */
export function Bar({
  pct,
  color = "var(--navy)",
  height = 10,
  radius = 999,
  animate = true,
}: {
  pct: number;
  color?: string;
  height?: number;
  radius?: number;
  animate?: boolean;
}) {
  return (
    <div style={{ height, background: "var(--track)", borderRadius: radius, overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: radius,
          transformOrigin: "left",
          animation: animate ? "growX .7s cubic-bezier(.2,.8,.2,1) both" : undefined,
          transition: "width .45s cubic-bezier(.2,.8,.2,1)",
        }}
      />
    </div>
  );
}

/** Placeholder rows shown while data loads, shaped like the content coming. */
export function Skeleton({ rows = 3, style }: { rows?: number; style?: React.CSSProperties }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0", ...style }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 14, width: `${[92, 76, 84, 64, 88][i % 5]}%` }} />
      ))}
    </div>
  );
}

/**
 * Centered message for empty and error states. A plain "Loading…" becomes
 * skeleton rows, so every list that used to show the bare word now shows the
 * shape of what's coming instead.
 */
export function Note({ children }: { children: React.ReactNode }) {
  if (typeof children === "string" && /^Loading\b/.test(children)) return <Skeleton />;
  return (
    <div style={{ padding: "24px 8px", textAlign: "center", color: "var(--mute)", fontSize: 14, lineHeight: "20px" }}>
      {children}
    </div>
  );
}
