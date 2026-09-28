import { Bar } from "./ui";

/** Counties done out of the state's total, as a bar with the count beside it. */
export default function ProgressBar({ completed, total, label }: {
  completed: number;
  total: number;
  label?: string;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div>
      {label && <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <Bar pct={pct} height={8} />
        </div>
        <span className="num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap" }}>{pct}%</span>
      </div>
      <div className="meta num" style={{ marginTop: 6 }}>{completed} of {total} counties</div>
    </div>
  );
}
