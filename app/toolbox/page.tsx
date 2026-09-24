"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronRight,
  FileMinus2,
  FilePlus2,
  FileText,
  FolderOpen,
  NotebookPen,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import {
  Page,
  Card,
  PageHeading,
  SectionHeader,
  Eyebrow,
  StatTile,
  Bar,
  Note,
  useRoll,
  fmtInt,
  fmtMoney,
} from "../../components/ui";
type LetterStats = {
  total: number;
  total_fees: number;
  by_rep: { rep_name: string | null; count: number }[];
};

type LetterRow = {
  id: number;
  client_name: string | null;
  rep_name: string | null;
  doc_tab: string | null;
  updated_at: string | null;
};

const DOC_LABELS: Record<string, string> = {
  pre: "Pre-award",
  "pre-award": "Pre-award",
  inh: "In-house",
  "in-house": "In-house",
  post: "Post-award",
  "post-award": "Post-award",
  proposal: "Proposal",
  addendum: "Addendum",
};

const docLabel = (t?: string | null) =>
  (t && (DOC_LABELS[t] || t.replace(/\b\w/g, (l) => l.toUpperCase()))) || "Letter";

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Action card. `feature` renders it as the navy card for the main job here.
 *
 * `right` is for a card that carries live state — the deadline count, say. It
 * goes through here rather than being styled at the call site, so a card with a
 * status pill still sits on the same padding, radius, shadow and hover as every
 * card without one.
 */
function ActionCard({
  icon: Icon,
  title,
  description,
  onClick,
  feature = false,
  badge,
  right,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  feature?: boolean;
  badge?: string;
  right?: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={feature ? "action-card action-card-feature" : "action-card"}>
      <span className="action-card-icon" aria-hidden>
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="action-card-title">
          {title}
          {badge && (
            <span className="badge badge-outline" style={{ marginLeft: 8, verticalAlign: 1 }}>
              {badge}
            </span>
          )}
        </span>
        <span className="action-card-desc">{description}</span>
      </span>
      {right}
      {feature ? (
        <span className="action-card-go">
          Start <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        </span>
      ) : (
        <ChevronRight className="action-card-chevron" size={18} strokeWidth={1.75} aria-hidden />
      )}
    </button>
  );
}

export default function ToolboxPage() {
  const router = useRouter();
  const [stats, setStats] = useState<LetterStats | null>(null);
  const [letters, setLetters] = useState<LetterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, l] = await Promise.allSettled([
        fetch("/api/letters/stats", { headers: authHeaders(), cache: "no-store" }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))
        ),
        fetch("/api/letters", { headers: authHeaders(), cache: "no-store" }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`letters ${r.status}`))
        ),
      ]);
      if (!alive) return;
      if (s.status === "fulfilled") setStats(s.value);
      else setError((s.reason as Error)?.message || "Could not load letter stats");
      if (l.status === "fulfilled") setLetters(l.value);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const roll = useRoll(loading ? "loading" : "ready");

  const leaders = useMemo(() => {
    // Show every rep — the live leaderboard doesn't truncate.
    const rows = (stats?.by_rep || []).filter((r) => r.rep_name);
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r, i) => ({
      rank: i + 1,
      name: r.rep_name as string,
      count: r.count,
      pct: (r.count / max) * 100,
    }));
  }, [stats]);

  return (
    <Page>
      <PageHeading
        description="Engagement letters, proposals and addendums, pre-call notes, and the reps letters are credited to."
        style={{ marginBottom: 28 }}
      >
        Sales Toolbox
      </PageHeading>

      {error && (
        <Card style={{ marginBottom: 16, borderColor: "var(--err-line)", background: "var(--err-bg)" }}>
          <Eyebrow color="var(--err-fg)" style={{ marginBottom: 4, fontWeight: 600 }}>
            Letter data unavailable
          </Eyebrow>
          <div style={{ fontSize: 14, lineHeight: "20px", color: "var(--sec)" }}>
            {error}. The tools below still work.
          </div>
        </Card>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <StatTile
          label="Letters generated"
          value={loading ? "—" : fmtInt((stats?.total || 0) * roll)}
          note="All time · all reps"
        />
        <StatTile
          label="Fees in saved letters"
          value={loading ? "—" : fmtMoney((stats?.total_fees || 0) * roll)}
          note="Across every saved letter"
          accent
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Eyebrow style={{ margin: "4px 0 0" }}>Engagement letters</Eyebrow>
          <ActionCard
            feature
            icon={FilePlus2}
            title="Generate a new letter"
            description="Pre-award, in-house or post-award, priced from the 6.14.2026 NPSA sheet."
            onClick={() => router.push("/loe?view=generator")}
          />
          <ActionCard
            icon={FolderOpen}
            title="Open a saved letter"
            description="Search and reload a saved draft."
            onClick={() => router.push("/loe?view=letters")}
          />

          <Eyebrow style={{ margin: "14px 0 0" }}>Proposals and addendums</Eyebrow>
          <ActionCard
            icon={FileText}
            title="New proposal"
            description="A one-page summary of scope and price for leadership."
            onClick={() => router.push("/loe?view=proposal")}
          />
          <ActionCard
            icon={FileMinus2}
            title="New addendum"
            description="Remove Implementation Period services from a signed letter."
            onClick={() => router.push("/loe?view=addendum")}
          />

          <Eyebrow style={{ margin: "14px 0 0" }}>Before a call</Eyebrow>
          <ActionCard
            icon={NotebookPen}
            title="Pre-call notes"
            description="Paste a Calendly invite and get prep notes for the meeting."
            onClick={() => router.push("/loe?view=precall")}
          />

          <Eyebrow style={{ margin: "14px 0 0" }}>Settings</Eyebrow>
          <ActionCard
            icon={UsersRound}
            title="Sales reps"
            description="Add or remove the reps letters are credited to. They drive the leaderboard."
            onClick={() => router.push("/loe?view=settings")}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card>
            <SectionHeader title="Rep leaderboard" meta="Letters generated" style={{ marginBottom: 16 }} />
            {loading ? (
              <Note>Loading…</Note>
            ) : leaders.length === 0 ? (
              <Note>No letters recorded yet.</Note>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                {leaders.map((p) => (
                  <div
                    key={p.name}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "26px 70px 1fr 70px",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        fontWeight: 600,
                        fontSize: 12,
                        fontVariantNumeric: "tabular-nums",
                        background: p.rank === 1 ? "var(--navy)" : "var(--sand)",
                        color: p.rank === 1 ? "var(--on-accent)" : "var(--sec)",
                      }}
                    >
                      {p.rank}
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
                      {p.name}
                    </span>
                    <Bar pct={p.pct} height={8} />
                    <span
                      style={{
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--sec)",
                        textAlign: "right",
                      }}
                    >
                      <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{p.count}</strong>{" "}
                      {p.count === 1 ? "letter" : "letters"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeader title="Recent letters" style={{ marginBottom: 6 }} />
            {loading ? (
              <Note>Loading…</Note>
            ) : letters.length === 0 ? (
              <Note>No letters saved yet.</Note>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {letters.slice(0, 6).map((l, i, shown) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 0",
                      borderBottom: i < shown.length - 1 ? "1px solid var(--hair2)" : "none",
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
                        {l.client_name || "Untitled"}
                      </span>
                      <span style={{ display: "block", fontSize: 13, color: "var(--mute)" }}>{docLabel(l.doc_tab)}</span>
                    </span>
                    <span style={{ fontSize: 13, color: "var(--sec)", whiteSpace: "nowrap" }}>
                      {l.rep_name || ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

    </Page>
  );
}
