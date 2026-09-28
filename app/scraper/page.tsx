"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Download, Plus, X } from "lucide-react";
import {
  Page,
  Card,
  PageHeading,
  SectionHeader,
  StatTile,
  ChipRow,
  SegPill,
  Button,
  StatusPill,
  Tag,
  Pulse,
  Bar,
  Note,
  useRoll,
  fmtInt,
  type StatusTone,
} from "../../components/ui";
import {
  fetchRuns,
  fetchQueue,
  fetchPipelineStatus,
  startPipeline,
  downloadCsv,
  cancelQueueJob,
} from "../../lib/api";
import { US_STATES, estimateRunTime } from "../../lib/constants";
import type { RunMetadata, QueueJob, PipelineStatus, ScraperType } from "../../lib/types";

// Large inline SVG — keep it out of the initial bundle.
const USStateMap = dynamic(() => import("../../components/USStateMap"), { ssr: false });

type Filter = "all" | "school" | "church";

type Row = {
  key: string;
  name: string;
  type: ScraperType;
  started: string;
  contacts: string;
  tone: StatusTone;
  label: string;
  runId?: string;
  queueJobId?: number;
  canDownload: boolean;
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "school", label: "Schools" },
  { key: "church", label: "Churches" },
];

const prettyState = (s?: string) =>
  s ? s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "Unknown";

function runTitle(r: { display_name?: string; state?: string }, type: ScraperType): string {
  if (r.display_name?.trim()) return r.display_name;
  return `${prettyState(r.state)} — ${type === "church" ? "Churches" : "Schools"}`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtElapsed(fromIso?: string): string {
  if (!fromIso) return "—";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

const isDone = (s: string) => s === "done" || s === "completed";
const isActive = (s: string) => s === "running" || s === "finalizing";

export default function ScraperPage() {
  const [runs, setRuns] = useState<RunMetadata[]>([]);
  const [queue, setQueue] = useState<(QueueJob & { type: ScraperType })[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  const [newOpen, setNewOpen] = useState(false);
  const [npState, setNpState] = useState("");
  const [npType, setNpType] = useState<ScraperType>("school");
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const [activeStatus, setActiveStatus] = useState<PipelineStatus | null>(null);

  const load = useCallback(async () => {
    const [sRuns, cRuns, sQ, cQ] = await Promise.allSettled([
      fetchRuns("school"),
      fetchRuns("church"),
      fetchQueue("school"),
      fetchQueue("church"),
    ]);
    const merged: RunMetadata[] = [];
    if (sRuns.status === "fulfilled")
      merged.push(...sRuns.value.map((r) => ({ ...r, scraper_type: "school" as ScraperType })));
    if (cRuns.status === "fulfilled")
      merged.push(...cRuns.value.map((r) => ({ ...r, scraper_type: "church" as ScraperType })));
    merged.sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
    setRuns(merged);

    const q: (QueueJob & { type: ScraperType })[] = [];
    if (sQ.status === "fulfilled") q.push(...sQ.value.map((j) => ({ ...j, type: "school" as ScraperType })));
    if (cQ.status === "fulfilled") q.push(...cQ.value.map((j) => ({ ...j, type: "church" as ScraperType })));
    setQueue(q);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const activeRun = useMemo(() => runs.find((r) => isActive(r.status)), [runs]);

  useEffect(() => {
    if (!activeRun) {
      setActiveStatus(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const st = await fetchPipelineStatus(activeRun.scraper_type || "school", activeRun.run_id);
        if (alive) setActiveStatus(st);
      } catch {
        /* transient */
      }
    };
    poll();
    const iv = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [activeRun]);

  const totalContacts = useMemo(
    () => runs.filter((r) => isDone(r.status)).reduce((n, r) => n + (r.total_contacts || 0), 0),
    [runs]
  );
  const completedCount = useMemo(() => runs.filter((r) => isDone(r.status)).length, [runs]);
  const activeCount = useMemo(() => runs.filter((r) => isActive(r.status)).length, [runs]);
  const roll = useRoll(loading ? "loading" : "ready");

  const rows: Row[] = useMemo(() => {
    const queued: Row[] = queue.map((j) => ({
      key: `q-${j.type}-${j.id}`,
      name: runTitle(j, j.type),
      type: j.type,
      started: "Queued",
      contacts: "—",
      tone: "queued",
      label: "Queued",
      queueJobId: j.id,
      canDownload: false,
    }));
    const done: Row[] = runs.map((r) => {
      const type = (r.scraper_type || "school") as ScraperType;
      const failed = r.status === "failed" || r.status === "cancelled";
      return {
        key: `r-${r.run_id}`,
        name: runTitle(r, type),
        type,
        started: fmtDate(r.created_at),
        contacts: r.total_contacts != null ? fmtInt(r.total_contacts) : "—",
        tone: isActive(r.status) ? "running" : failed ? "error" : "done",
        label: isActive(r.status)
          ? r.status === "finalizing"
            ? "Finalizing"
            : "Running"
          : failed
          ? r.status.charAt(0).toUpperCase() + r.status.slice(1)
          : "Finished",
        runId: r.run_id,
        canDownload: isDone(r.status),
      };
    });
    return [...queued, ...done].filter((r) => filter === "all" || r.type === filter);
  }, [runs, queue, filter]);

  const startScan = async () => {
    if (!npState) return;
    setStarting(true);
    setMsg(null);
    try {
      const res = await startPipeline(npType, npState);
      setMsg({
        tone: "ok",
        text:
          res.status === "queued"
            ? `Queued as job #${res.jobId}${res.position ? `, position ${res.position}` : ""}.`
            : "Scrape started.",
      });
      setNewOpen(false);
      setNpState("");
      load();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setStarting(false);
    }
  };

  // Coverage map: a state counts as cleared once its run has finished; runs
  // still going are flagged "In Progress" so the map pulses them.
  const stateData = useMemo(() => {
    const out: Record<string, any> = {};
    for (const r of runs) {
      const key = r.state?.toLowerCase().replace(/\s+/g, "_");
      if (!key) continue;
      const type = (r.scraper_type || "school") as ScraperType;
      const slot = type === "church" ? "churchRun" : "schoolRun";
      if (!out[key]) out[key] = { state: key };
      // Keep the first (most recent) run per state+type; runs are sorted desc.
      if (out[key][slot]) continue;
      if (!isDone(r.status) && !isActive(r.status)) continue;
      out[key][slot] = {
        total_contacts: r.total_contacts || 0,
        total_counties: r.total_counties || 0,
        completed_at: isActive(r.status) ? "In Progress" : r.completed_at || r.created_at || "",
        display_name: runTitle(r, type),
      };
    }
    return out;
  }, [runs]);

  const clearedCount = useMemo(
    () =>
      Object.values(stateData).filter((d: any) =>
        filter === "school" ? d.schoolRun : filter === "church" ? d.churchRun : d.schoolRun && d.churchRun
      ).length,
    [stateData, filter]
  );

  const activeTotal = activeStatus?.totalCounties ?? activeStatus?.total_counties ?? 0;
  const activeDone = activeStatus?.countiesProcessed ?? activeStatus?.counties_processed ?? 0;
  const activePct = activeTotal > 0 ? Math.round((activeDone / activeTotal) * 100) : 0;
  const activeContacts = activeStatus?.totalContacts ?? activeStatus?.total_contacts ?? 0;

  return (
    <Page>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 24,
        }}
      >
        <PageHeading description="Find contacts at schools and churches, one state at a time, county by county.">
          Scraper
        </PageHeading>
        <Button icon={newOpen ? X : Plus} variant={newOpen ? "secondary" : "primary"} onClick={() => setNewOpen((v) => !v)} aria-expanded={newOpen}>
          {newOpen ? "Close" : "New scrape"}
        </Button>
      </div>

      {msg && (
        <Card
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            borderColor: msg.tone === "err" ? "var(--err-line)" : "var(--bd2)",
            background: msg.tone === "err" ? "var(--err-bg)" : "var(--ok-bg)",
          }}
        >
          <span role="status" style={{ fontSize: 14, lineHeight: "20px", color: msg.tone === "err" ? "var(--err-fg)" : "var(--ok-fg)" }}>{msg.text}</span>
        </Card>
      )}

      {newOpen && (
        <Card
          className="fade-up"
          style={{
            marginBottom: 16,
            display: "flex",
            gap: 20,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div>
            <label htmlFor="np-state" className="eyebrow" style={{ display: "block", color: "var(--sec)", marginBottom: 6 }}>
              State
            </label>
            <select
              id="np-state"
              className="field"
              value={npState}
              onChange={(e) => setNpState(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">Select a state…</option>
              {US_STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="eyebrow" style={{ display: "block", color: "var(--sec)", marginBottom: 6 }}>
              Type
            </span>
            <SegPill<ScraperType>
              options={[
                { key: "school", label: "Schools" },
                { key: "church", label: "Churches" },
              ]}
              value={npType}
              onChange={setNpType}
              label="Type"
            />
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: "18px",
              color: "var(--mute)",
              fontVariantNumeric: "tabular-nums",
              paddingBottom: 9,
            }}
          >
            {npState ? estimateRunTime(npState, npType) : "Pick a state to see how long it takes"}
          </div>

          <Button onClick={startScan} disabled={!npState || starting} busy={starting} style={{ marginLeft: "auto" }}>
            {starting ? "Starting…" : "Start scrape"}
          </Button>
        </Card>
      )}

      <div style={{ marginBottom: 16 }}>
        <ChipRow options={FILTERS} value={filter} onChange={setFilter} label="Show" />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <StatTile
          label="Total contacts"
          value={fmtInt(totalContacts * roll)}
          note="Across all completed runs"
        />
        <StatTile
          label="Completed runs"
          value={fmtInt(completedCount * roll)}
          note="Schools and churches"
        />
        <StatTile
          label="Active now"
          value={fmtInt(activeCount * roll)}
          note={`${queue.length} queued behind it`}
        />
      </div>

      {activeRun && (
        <Card style={{ marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <Link
              href={`/${activeRun.scraper_type || "school"}/${activeRun.run_id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 16,
                fontWeight: 600,
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              <Pulse />
              {runTitle(activeRun, (activeRun.scraper_type || "school") as ScraperType)}
            </Link>
            <StatusPill tone="running">
              {activeRun.status === "finalizing" ? "Finalizing" : "Running"}
            </StatusPill>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <Bar pct={activePct} height={8} />
            </div>
            <strong style={{ fontVariantNumeric: "tabular-nums", fontSize: 14, fontWeight: 600 }}>{activePct}%</strong>
          </div>

          <div
            style={{
              display: "flex",
              gap: 26,
              flexWrap: "wrap",
              fontSize: 13,
              color: "var(--sec)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span>
              <strong style={{ color: "var(--ink)", fontWeight: 600 }}>
                {activeDone} of {activeTotal || "—"}
              </strong>{" "}
              counties
            </span>
            {activeStatus?.currentCounty && (
              <span>
                Now in <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{activeStatus.currentCounty}</strong>
              </span>
            )}
            <span>
              Running for{" "}
              <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{fmtElapsed(activeRun.created_at)}</strong>
            </span>
            <span>
              <strong style={{ color: "var(--olive-ink)", fontWeight: 600 }}>{fmtInt(activeContacts)}</strong>{" "}
              contacts so far
            </span>
          </div>
        </Card>
      )}

      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <h2 className="section-title">Runs</h2>
          <span className="meta">{rows.length} {rows.length === 1 ? "run" : "runs"}</span>
        </div>

        {loading ? (
          <Note>Loading runs…</Note>
        ) : rows.length === 0 ? (
          <Note>No runs yet. Start one with New scrape.</Note>
        ) : (
          <div style={{ overflowX: "auto" }} className="table-responsive">
            <div style={{ minWidth: 640 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1.2fr 1fr 1fr .7fr",
                  gap: 12,
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--hair)",
                }}
              >
                {["Run", "Type", "Started", "Contacts", "Status", ""].map((h, i) => (
                  <span
                    key={h || i}
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      lineHeight: "16px",
                      color: "var(--sec)",
                      textAlign: i === 3 ? "right" : "left",
                    }}
                  >
                    {h}
                  </span>
                ))}
              </div>

              {/* Scrolls inside the card so a long run history stops pushing
                  the coverage map off the page — same treatment as the
                  bookings table on the dashboard. */}
              <div style={{ maxHeight: 460, overflowY: "auto" }}>
                {rows.map((r, i) => (
                  <div
                    key={r.key}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "2fr 1fr 1.2fr 1fr 1fr .7fr",
                      gap: 12,
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--hair2)",
                      alignItems: "center",
                      animation: "fadeUp .35s ease both",
                      animationDelay: `${Math.min(i, 12) * 30}ms`,
                    }}
                    className="row-hover"
                  >
                    {r.runId ? (
                      <Link
                        href={`/${r.type}/${r.runId}`}
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "var(--ink)",
                          textDecoration: "none",
                        }}
                      >
                        {r.name}
                      </Link>
                    ) : (
                      <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
                        {r.name}
                      </span>
                    )}
                    <span>
                      <Tag>{r.type === "school" ? "School" : "Church"}</Tag>
                    </span>
                    <span
                      style={{ fontSize: 14, color: "var(--sec)", fontVariantNumeric: "tabular-nums" }}
                    >
                      {r.started}
                    </span>
                    <span
                      style={{
                        fontSize: 14,
                        color: "var(--sec)",
                        fontVariantNumeric: "tabular-nums",
                        textAlign: "right",
                      }}
                    >
                      {r.contacts}
                    </span>
                    <span>
                      <StatusPill tone={r.tone}>{r.label}</StatusPill>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      {r.canDownload && r.runId && (
                        <Button
                          variant="quiet"
                          size="sm"
                          icon={Download}
                          onClick={() => downloadCsv(r.type, r.runId!)}
                          title="Download contacts as CSV"
                        >
                          CSV
                        </Button>
                      )}
                      {r.queueJobId != null && (
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={async () => {
                            await cancelQueueJob(r.type, r.queueJobId!);
                            load();
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Coverage map */}
      <Card style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 className="section-title">Coverage</h2>
            <span className="meta">
              {filter === "all" ? "Schools and churches" : filter === "school" ? "Schools" : "Churches"}
            </span>
          </div>
          <span className="meta">{clearedCount} of 50 states cleared</span>
        </div>

        <div
          style={{
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
            marginBottom: 10,
            alignItems: "center",
          }}
        >
          {(filter === "all"
            ? [
                { c: "var(--olive)", l: "Cleared, both types" },
                { c: "var(--navy)", l: "One type only" },
                { c: "var(--track)", l: "Not yet run" },
              ]
            : [
                { c: "var(--olive)", l: "Cleared" },
                { c: "var(--track)", l: "Not yet run" },
              ]
          ).map((k) => (
            <span
              key={k.l}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                lineHeight: "18px",
                color: "var(--sec)",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: k.c,
                  border: "1px solid var(--line-strong)",
                }}
              />
              {k.l}
            </span>
          ))}
        </div>

        <USStateMap stateData={stateData} filter={filter} />
      </Card>
    </Page>
  );
}
