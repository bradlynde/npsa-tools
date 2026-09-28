/** A run or county status as a badge: tone plus a dot, sentence case. */
const TONE: Record<string, string> = {
  running: "badge-run",
  finalizing: "badge-run",
  processing: "badge-run",
  done: "badge-ok",
  completed: "badge-ok",
  failed: "badge-err",
  cancelled: "badge-err",
  queued: "badge-warn",
  pending: "badge-neutral",
};

export default function StatusBadge({ status }: { status: string }) {
  const s = String(status || "unknown");
  return <span className={`badge badge-dot ${TONE[s] || "badge-neutral"}`}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>;
}
