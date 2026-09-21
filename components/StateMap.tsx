"use client";
import { useCallback, useRef, useState } from "react";
import { US_STATE_PATHS } from "../lib/us-state-paths";
import { nameFromSlug } from "../lib/states";

/**
 * The US map, and nothing about what it means.
 *
 * The scraper colours states by what has been scraped; the grant knowledge tab
 * colours them by deadlines, freshness or state money, and lets you pick one.
 * Both hand this component a colour per state and, if they want them, a tooltip
 * and a selection handler. State ids are the snake_case slugs of
 * lib/us-state-paths.ts ("new_york", "district_of_columbia").
 */
export interface StateMapProps {
  colorFor: (slug: string) => string;
  /** Slug of the selected state, drawn last with a heavy outline. */
  selected?: string | null;
  /** Makes every state a button: click, Enter or Space. */
  onSelect?: (slug: string) => void;
  renderTooltip?: (slug: string) => React.ReactNode;
  pulsing?: (slug: string) => boolean;
  /** A dashed outline, for "we do not know". */
  dashed?: (slug: string) => boolean;
  /** Pointer cursor without onSelect, for maps that are only hoverable. */
  hoverable?: (slug: string) => boolean;
  ariaLabelFor?: (slug: string) => string;
}

// Alaska: rotate -30deg, scale 1.2x, move down near Hawaii. Hawaii: rotate -30deg, shift right.
const TRANSFORMS: Record<string, string> = {
  alaska: "translate(170,545) scale(1.2) rotate(-30) translate(-170,-475)",
  hawaii: "translate(330,515) rotate(-30) translate(-300,-515)",
};

export default function StateMap({ colorFor, selected, onSelect, renderTooltip, pulsing, dashed, hoverable, ariaLabelFor }: StateMapProps) {
  const [tip, setTip] = useState<{ x: number; y: number; slug: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const move = useCallback((e: React.MouseEvent, slug: string) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, slug });
  }, []);

  // The paths keep one order. Reordering them so the selected one drew last moved
  // a state's DOM node between mousedown and mouseup (focus fires on mousedown), and
  // the browser dropped the click: every state took two clicks to open. The heavy
  // outline is a separate path drawn over everything instead.
  const order = Object.keys(US_STATE_PATHS);
  const outlined = [selected, focused].filter((s): s is string => !!s && s in US_STATE_PATHS);

  return (
    <div ref={box} style={{ position: "relative", width: "100%" }}>
      <svg viewBox="59 16 824 557" style={{ width: "100%", height: "auto", display: "block" }} xmlns="http://www.w3.org/2000/svg" role={onSelect ? "group" : "img"} aria-label="Map of the United States">
        <defs>
          <style>{`@keyframes statePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }`}</style>
        </defs>
        {order.map((slug) => {
          const isSelected = slug === selected;
          const label = ariaLabelFor ? ariaLabelFor(slug) : nameFromSlug(slug) || slug;
          return (
            <path
              key={slug}
              d={US_STATE_PATHS[slug]}
              fill={colorFor(slug)}
              stroke={dashed?.(slug) ? "var(--faint)" : "var(--card)"}
              strokeWidth={1}
              strokeDasharray={dashed?.(slug) ? "3 2.5" : undefined}
              strokeLinejoin="round"
              transform={TRANSFORMS[slug]}
              style={{
                cursor: onSelect || hoverable?.(slug) ? "pointer" : "default",
                opacity: tip?.slug === slug && !isSelected ? 0.82 : 1,
                transition: "opacity 0.15s ease",
                animation: pulsing?.(slug) ? "statePulse 2s ease-in-out infinite" : "none",
                outline: "none",
              }}
              onMouseMove={(e) => move(e, slug)}
              onMouseLeave={() => setTip(null)}
              {...(onSelect
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-label": label,
                    "aria-pressed": isSelected,
                    onClick: () => onSelect(slug),
                    onFocus: (e: React.FocusEvent) => { if (e.currentTarget.matches(":focus-visible")) setFocused(slug); },
                    onBlur: () => setFocused(null),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(slug); }
                    },
                  }
                : {})}
            />
          );
        })}
        {[...new Set(outlined)].map((slug) => (
          <path key={`outline-${slug}`} d={US_STATE_PATHS[slug]} fill="none" stroke="var(--ink)" strokeWidth={slug === selected ? 2.4 : 2} strokeLinejoin="round" transform={TRANSFORMS[slug]} pointerEvents="none" aria-hidden="true" />
        ))}
      </svg>

      {tip && renderTooltip && (
        <div
          style={{
            position: "absolute",
            left: Math.max(0, Math.min(tip.x + 12, (box.current?.clientWidth || 600) - 240)),
            top: tip.y - 10,
            background: "var(--tip-bg)",
            color: "var(--tip-fg)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 12,
            zIndex: 1000,
            pointerEvents: "none",
            minWidth: 160,
            maxWidth: 240,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          }}
        >
          {renderTooltip(tip.slug)}
        </div>
      )}
    </div>
  );
}
