"use client";

import React, { useEffect, useRef, useState } from "react";

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

/* ── Layout ─────────────────────────────────────────────────────── */

/** Centered page frame — owns the max width and page padding. */
export function Page({ children }: { children: React.ReactNode }) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return (
    <div
      className="fade-up"
      style={{
        width: "100%",
        maxWidth: 1280,
        margin: "0 auto",
        padding: mobile ? "24px 18px 40px" : "36px 40px 56px",
      }}
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
        // A white card on a near-white page needs a border that actually reads;
        // --bd is too close to --bg to separate one card from the next.
        border: "1px solid var(--bd2)",
        borderRadius: 16,
        padding: "22px 24px",
        // The resting shadow lives in .card-surface, not here: an inline
        // box-shadow outranks .lift:hover, which is what kept the hover
        // shadow from ever showing. Callers can still override via `style`.
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Mono, lowercase, wide-tracked section label. */
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
    <div
      className="mono"
      style={{
        fontWeight: 500,
        fontSize: 12,
        letterSpacing: ".08em",
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Olive eyebrow + serif headline; `em` inside `title` renders as the accent phrase. */
export function PageHeading({
  eyebrow,
  children,
  style,
}: {
  eyebrow: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <Eyebrow color="var(--olive)" style={{ marginBottom: 9 }}>
        {eyebrow}
      </Eyebrow>
      <h1 className="headline">{children}</h1>
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
  // The entrance animation sits on a wrapper, not on the Card. `fadeUp` with
  // fill-mode `both` keeps its final `transform: none` applied for good, and an
  // animated property outranks a normal one in the cascade — so leaving it on
  // the Card silently cancels `.lift:hover`.
  return (
    <div style={{ animation: "fadeUp .5s ease both", animationDelay: `${delay}ms` }}>
      <Card hover style={{ padding: "20px 22px", height: "100%" }}>
        <div
          className="mono"
          style={{
            fontWeight: 500,
            fontSize: 11.5,
            letterSpacing: ".07em",
            color: "var(--mute)",
            marginBottom: 11,
          }}
        >
          {label}
        </div>
        <div className="kpi" style={{ color: accent ? "var(--olive)" : "var(--ink)" }}>
          {value}
        </div>
        {note && (
          <div style={{ fontSize: 12.5, color: "var(--mute)", marginTop: 9 }}>{note}</div>
        )}
      </Card>
    </div>
  );
}

/* ── Controls ───────────────────────────────────────────────────── */

export type SegOption<T extends string> = { key: T; label: string };

/** Segmented pill — the active segment lifts onto a raised surface. */
export function SegPill<T extends string>({
  options,
  value,
  onChange,
  size = "md",
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--seg)",
        border: "1px solid var(--hair)",
        borderRadius: 999,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={on}
            className="mono"
            style={{
              fontWeight: 600,
              fontSize: 12,
              padding: size === "sm" ? "5px 14px" : "7px 16px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              transition: "all .25s cubic-bezier(.34,1.3,.4,1)",
              background: on ? "var(--seg-active)" : "transparent",
              color: on ? "var(--ink)" : "var(--chip-muted)",
              boxShadow: on ? "0 1px 5px rgba(20,30,45,.12)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Filter chips — active fills navy (distinct from the raised SegPill). */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--seg)",
        border: "1px solid var(--hair)",
        borderRadius: 999,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={on}
            className="mono"
            style={{
              fontWeight: 600,
              fontSize: 12,
              padding: "7px 16px",
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              transition: "all .25s cubic-bezier(.34,1.3,.4,1)",
              background: on ? "var(--navy)" : "transparent",
              color: on ? "var(--on-accent)" : "var(--chip-muted)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
  const tones: Record<string, React.CSSProperties> = {
    navy: { background: "var(--navy)", color: "var(--on-accent)", border: "none" },
    olive: { background: "var(--olive)", color: "var(--on-accent)", border: "none" },
    outline: {
      background: "none",
      color: "var(--navy)",
      border: "1.5px solid var(--navy)",
    },
    white: { background: "#fff", color: "var(--navycard)", border: "none" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        font: "inherit",
        fontSize: 13.5,
        fontWeight: 700,
        borderRadius: 999,
        padding: "10px 20px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "transform .2s, box-shadow .2s, opacity .2s",
        ...tones[tone],
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
      }}
    >
      {children}
    </button>
  );
}

/* ── Status ─────────────────────────────────────────────────────── */

export type StatusTone = "running" | "queued" | "done" | "error";

const TONES: Record<StatusTone, { fg: string; bg: string }> = {
  running: { fg: "var(--run-fg)", bg: "var(--run-bg)" },
  queued: { fg: "var(--q-fg)", bg: "var(--q-bg)" },
  done: { fg: "var(--ok-fg)", bg: "var(--ok-bg)" },
  error: { fg: "var(--err-fg)", bg: "var(--err-bg)" },
};

export function StatusPill({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <span
      className="mono"
      style={{
        fontWeight: 600,
        fontSize: 10.5,
        letterSpacing: ".06em",
        padding: "3px 11px",
        borderRadius: 999,
        color: t.fg,
        background: t.bg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Outlined mono tag — used for SCHOOL / CHURCH. */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        fontWeight: 600,
        fontSize: 10.5,
        letterSpacing: ".05em",
        border: "1px solid var(--bd2)",
        color: "var(--sec)",
        padding: "2px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Live indicator: solid dot + expanding ping ring. */
export function Pulse({ color = "var(--olive)" }: { color?: string }) {
  return (
    <span
      style={{ position: "relative", width: 9, height: 9, flexShrink: 0, display: "inline-block" }}
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
  height = 14,
  radius = 5,
  animate = true,
}: {
  pct: number;
  color?: string;
  height?: number;
  radius?: number;
  animate?: boolean;
}) {
  return (
    <div style={{ height, background: "var(--track)", borderRadius: radius }}>
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: radius,
          transformOrigin: "left",
          animation: animate ? "growX .9s cubic-bezier(.34,1.3,.4,1) both" : undefined,
          transition: "width .55s cubic-bezier(.34,1.3,.4,1)",
        }}
      />
    </div>
  );
}

/** Full-card centered message, used for loading and empty states. */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "26px 4px", textAlign: "center", color: "var(--mute)", fontSize: 13.5 }}>
      {children}
    </div>
  );
}
