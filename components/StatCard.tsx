import type { ReactNode } from "react";

/**
 * Stat tile for the run screens. Mirrors StatTile in components/ui.tsx (label,
 * serif figure, a line of context) but keeps this component's own prop shape so
 * the run detail and new-run screens don't need rewriting.
 */
export default function StatCard({ label, value, subtitle, icon }: {
  label: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      className="card-surface"
      style={{
        background: "var(--card)",
        borderRadius: "var(--r-lg)",
        padding: "18px 20px",
        border: "1px solid var(--bd2)",
        flex: 1,
        minWidth: 160,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div className="eyebrow">{label}</div>
          <div className="kpi" style={{ fontSize: 34, lineHeight: "40px", color: "var(--ink)" }}>
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
          {subtitle && <div className="meta">{subtitle}</div>}
        </div>
        {icon && <div style={{ color: "var(--navy)", opacity: 0.7 }}>{icon}</div>}
      </div>
    </div>
  );
}
