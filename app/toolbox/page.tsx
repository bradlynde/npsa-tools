"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Page,
  Card,
  PageHeading,
  Eyebrow,
  StatTile,
  Bar,
  Note,
  useRoll,
  fmtInt,
  fmtMoney,
} from "../../components/ui";
import { DeadlinesCard, DeadlinesModal, useDeadlines } from "../../components/DeadlinesPanel";
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

/** Roman-numeral action card. `feature` renders it as the navy hero card. */
function ActionCard({
  numeral,
  title,
  description,
  onClick,
  feature = false,
  badge,
}: {
  numeral: string;
  title: string;
  description: string;
  onClick: () => void;
  feature?: boolean;
  badge?: string;
}) {
  const base: React.CSSProperties = {
    borderRadius: 16,
    padding: "22px 24px",
    cursor: "pointer",
    display: "flex",
    gap: 18,
    alignItems: "baseline",
    transition: "transform .25s cubic-bezier(.34,1.4,.4,1), box-shadow .25s",
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={
        feature
          ? { ...base, background: "var(--navycard)", boxShadow: "var(--shadow-navy)" }
          : {
              ...base,
              background: "var(--card)",
              border: "1px solid var(--bd)",
              boxShadow: "var(--shadow-card)",
            }
      }
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-3px)";
        e.currentTarget.style.boxShadow = feature
          ? "0 16px 36px rgba(30,58,95,.35)"
          : "var(--shadow-card-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = feature ? "var(--shadow-navy)" : "var(--shadow-card)";
      }}
    >
      <span
        className="serif"
        style={{
          fontStyle: "italic",
          fontSize: 20,
          color: feature ? "rgba(255,255,255,.5)" : "var(--faint)",
        }}
      >
        {numeral}
      </span>
      <div style={{ flex: 1 }}>
        <h3
          style={{
            margin: "0 0 5px",
            fontSize: 16.5,
            fontWeight: 700,
            color: feature ? "#fff" : "var(--ink)",
          }}
        >
          {title}
          {badge && (
            <span
              className="mono"
              style={{
                fontWeight: 600,
                fontSize: 9.5,
                letterSpacing: ".07em",
                color: "var(--olive)",
                border: "1px solid var(--olive)",
                padding: "2px 8px",
                borderRadius: 999,
                verticalAlign: 2,
                marginLeft: 6,
              }}
            >
              {badge}
            </span>
          )}
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.5,
            color: feature ? "rgba(255,255,255,.72)" : "var(--sec)",
          }}
        >
          {description}
        </p>
      </div>
      {feature && (
        <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#fff" }}>
          start →
        </span>
      )}
    </div>
  );
}

export default function ToolboxPage() {
  const router = useRouter();
  const [stats, setStats] = useState<LetterStats | null>(null);
  const [letters, setLetters] = useState<LetterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeadlines, setShowDeadlines] = useState(false);
  const deadlines = useDeadlines();

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
      <PageHeading eyebrow="sales toolbox · loes & proposals" style={{ marginBottom: 26 }}>
        Paper that <em>closes.</em>
      </PageHeading>

      {error && (
        <Card style={{ marginBottom: 14, borderColor: "var(--err-fg)" }}>
          <Eyebrow color="var(--err-fg)" style={{ marginBottom: 6 }}>
            letter data unavailable
          </Eyebrow>
          <div style={{ fontSize: 13.5, color: "var(--sec)" }}>
            {error}. You can still open the Sales Toolbox directly — the tools below work
            regardless.
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
          label="total letters generated"
          value={loading ? "—" : fmtInt((stats?.total || 0) * roll)}
          note="all time · all reps"
        />
        <StatTile
          label="total fees generated"
          value={loading ? "—" : fmtMoney((stats?.total_fees || 0) * roll)}
          note="across all saved letters"
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
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Eyebrow style={{ margin: "6px 0 -4px" }}>engagement letters</Eyebrow>
          <ActionCard
            feature
            numeral="i."
            title="Generate New Letter"
            description="Pre-award, in-house, or post-award — pricing computed from the 6.14.2026 NPSA sheet."
            onClick={() => router.push("/loe?view=generator")}
          />
          <ActionCard
            numeral="ii."
            title="Load Previous Letter"
            description="Search and reload a saved draft."
            onClick={() => router.push("/loe?view=letters")}
          />

          <Eyebrow style={{ margin: "8px 0 -4px" }}>proposals &amp; addendums</Eyebrow>
          <ActionCard
            numeral="iii."
            title="New Proposal"
            description="One-page leadership summary of scope & price."
            onClick={() => router.push("/loe?view=proposal")}
          />
          <ActionCard
            numeral="iv."
            title="New Addendum"
            description="Remove Implementation Period services from a signed letter."
            onClick={() => router.push("/loe?view=addendum")}
          />

          <Eyebrow style={{ margin: "8px 0 -4px" }}>tools</Eyebrow>
          <ActionCard
            numeral="v."
            title="Pre-Call Notes Generator"
            badge="BETA"
            description="Paste a Calendly invite and generate AI-powered prep notes."
            onClick={() => router.push("/loe?view=precall")}
          />
          {/*
            Sits under the Pre-Call card because that is what it feeds, but it
            earns its place here rather than inside the generator: "is anything
            open right now?" is worth answering before a call is even booked.
          */}
          <DeadlinesCard
            onClick={() => setShowDeadlines(true)}
            open={deadlines.open}
            total={deadlines.rows?.length || 0}
            loading={deadlines.loading}
            error={deadlines.error}
          />

          <Eyebrow style={{ margin: "8px 0 -4px" }}>settings</Eyebrow>
          <ActionCard
            numeral="vi."
            title="Manage Sales Reps"
            description="Add or remove the reps letters are attributed to — they drive the leaderboard."
            onClick={() => router.push("/loe?view=settings")}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card>
            <Eyebrow style={{ marginBottom: 16 }}>rep leaderboard</Eyebrow>
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
                      className="mono"
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        fontWeight: 600,
                        fontSize: 11,
                        background: p.rank === 1 ? "var(--navy)" : "var(--card)",
                        color: p.rank === 1 ? "var(--on-accent)" : "var(--mute)",
                        border: p.rank === 1 ? "none" : "1px solid var(--bd2)",
                      }}
                    >
                      {p.rank}
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
                      {p.name}
                    </span>
                    <Bar pct={p.pct} height={12} radius={4} />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--sec)",
                        textAlign: "right",
                      }}
                    >
                      <strong style={{ color: "var(--ink)" }}>{p.count}</strong>{" "}
                      {p.count === 1 ? "letter" : "letters"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <Eyebrow style={{ marginBottom: 14 }}>recent letters</Eyebrow>
            {loading ? (
              <Note>Loading…</Note>
            ) : letters.length === 0 ? (
              <Note>No letters saved yet.</Note>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {letters.slice(0, 6).map((l) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 2px",
                      borderBottom: "1px solid var(--hair2)",
                    }}
                  >
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
                      {l.client_name || "Untitled"}{" "}
                      <span style={{ fontWeight: 500, color: "var(--mute)" }}>
                        — {docLabel(l.doc_tab)}
                      </span>
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}
                    >
                      {l.rep_name || ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {showDeadlines && deadlines.rows && (
        <DeadlinesModal
          rows={deadlines.rows}
          open={deadlines.open}
          onClose={() => setShowDeadlines(false)}
        />
      )}
    </Page>
  );
}
