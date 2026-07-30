"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Page,
  Card,
  PageHeading,
  Eyebrow,
  StatTile,
  ChipRow,
  PillButton,
  StatusPill,
  Tag,
  Pulse,
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
      label: "QUEUED",
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
            ? "FINALIZING"
            : "RUNNING"
          : failed
          ? r.status.toUpperCase()
          : "FINISHED",
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
            ? `Queued — job #${res.jobId}${res.position ? ` (position ${res.position})` : ""}.`
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

  const activeTotal = activeStatus?.totalCounties ?? activeStatus?.total_counties ?? 0;
  const activeDone = activeStatus?.countiesProcessed ?? activeStatus?.counties_processed ?? 0;
  const activePct = activeTotal > 0 ? Math.round((activeDone / activeTotal) * 100) : 0;
  const activeContacts = activeStatus?.totalContacts ?? activeStatus?.total_contacts ?? 0;

  return (
    <Page>
      <PageHeading eyebrow="contact scraper · schools & churches" style={{ marginBottom: 26 }}>
        One pipeline, <em>every county.</em>
      </PageHeading>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <ChipRow options={FILTERS} value={filter} onChange={setFilter} />
        <PillButton onClick={() => setNewOpen((v) => !v)}>
          {newOpen ? "Close" : "+ New Scrape"}
        </PillButton>
      </div>

      {msg && (
        <Card
          style={{
            marginBottom: 16,
            padding: "14px 18px",
            borderColor: msg.tone === "err" ? "var(--err-fg)" : "var(--ok-fg)",
          }}
        >
          <span style={{ fontSize: 13.5, color: "var(--sec)" }}>{msg.text}</span>
        </Card>
      )}

      {newOpen && (
        <div
          className="fade-up"
          style={{
            background: "var(--card)",
            border: "1px dashed var(--bd2)",
            borderRadius: 16,
            padding: "20px 22px",
            marginBottom: 16,
            display: "flex",
            gap: 20,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div>
            <label
              htmlFor="np-state"
              className="mono"
              style={{
                display: "block",
                fontWeight: 500,
                fontSize: 10.5,
                letterSpacing: ".07em",
                color: "var(--mute)",
                marginBottom: 6,
              }}
            >
              state
            </label>
            <select
              id="np-state"
              value={npState}
              onChange={(e) => setNpState(e.target.value)}
              style={{
                font: "inherit",
                fontSize: 14,
                padding: "10px 14px",
                borderRadius: 12,
                border: "1px solid var(--bd2)",
                background: "var(--card)",
                color: "var(--ink)",
                minWidth: 180,
              }}
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
            <span
              className="mono"
              style={{
                display: "block",
                fontWeight: 500,
                fontSize: 10.5,
                letterSpacing: ".07em",
                color: "var(--mute)",
                marginBottom: 6,
              }}
            >
              type
            </span>
            <div
              style={{
                display: "inline-flex",
                border: "1px solid var(--bd2)",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              {(["school", "church"] as ScraperType[]).map((t) => {
                const on = npType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNpType(t)}
                    aria-pressed={on}
                    style={{
                      font: "inherit",
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "10px 18px",
                      border: "none",
                      cursor: "pointer",
                      transition: "all .2s",
                      background: on ? "var(--navy)" : "transparent",
                      color: on ? "var(--on-accent)" : "var(--sec)",
                    }}
                  >
                    {t === "school" ? "Schools" : "Churches"}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className="mono"
            style={{
              fontWeight: 500,
              fontSize: 13,
              color: "var(--mute)",
              fontVariantNumeric: "tabular-nums",
              paddingBottom: 11,
            }}
          >
            {npState ? estimateRunTime(npState, npType) : "select a state"}
          </div>

          <PillButton tone="olive" onClick={startScan} disabled={!npState || starting}>
            {starting ? "Starting…" : "Start Scan"}
          </PillButton>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <StatTile
          label="total contacts"
          value={fmtInt(totalContacts * roll)}
          note="across all completed runs"
        />
        <StatTile
          label="completed runs"
          value={fmtInt(completedCount * roll)}
          note="school + church"
        />
        <StatTile
          label="active now"
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
                gap: 11,
                fontSize: 15,
                fontWeight: 700,
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              <Pulse />
              {runTitle(activeRun, (activeRun.scraper_type || "school") as ScraperType)}
            </Link>
            <StatusPill tone="running">
              {activeRun.status === "finalizing" ? "FINALIZING" : "RUNNING"}
            </StatusPill>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            <div style={{ flex: 1, height: 8, background: "var(--track)", borderRadius: 999 }}>
              <div
                style={{
                  width: `${activePct}%`,
                  height: "100%",
                  background: "var(--navy)",
                  borderRadius: 999,
                  transformOrigin: "left",
                  animation: "growX 1s cubic-bezier(.34,1.3,.4,1) both",
                  transition: "width .6s cubic-bezier(.34,1.3,.4,1)",
                }}
              />
            </div>
            <strong style={{ fontVariantNumeric: "tabular-nums", fontSize: 14 }}>{activePct}%</strong>
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
              <strong style={{ color: "var(--ink)" }}>
                {activeDone} / {activeTotal || "—"}
              </strong>{" "}
              counties
            </span>
            {activeStatus?.currentCounty && (
              <span>
                Now: <strong style={{ color: "var(--ink)" }}>{activeStatus.currentCounty}</strong>
              </span>
            )}
            <span>
              Elapsed:{" "}
              <strong style={{ color: "var(--ink)" }}>{fmtElapsed(activeRun.created_at)}</strong>
            </span>
            <span>
              Contacts so far:{" "}
              <strong style={{ color: "var(--olive)" }}>{fmtInt(activeContacts)}</strong>
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
          <Eyebrow>runs</Eyebrow>
          <Eyebrow color="var(--faint)">{rows.length} runs</Eyebrow>
        </div>

        {loading ? (
          <Note>Loading runs…</Note>
        ) : rows.length === 0 ? (
          <Note>No runs yet. Start one with “+ New Scrape”.</Note>
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
                {["RUN", "TYPE", "STARTED", "CONTACTS", "STATUS", ""].map((h, i) => (
                  <span
                    key={h || i}
                    className="mono"
                    style={{
                      fontWeight: 600,
                      fontSize: 10.5,
                      letterSpacing: ".07em",
                      color: "var(--faint)",
                      textAlign: i === 3 ? "right" : "left",
                    }}
                  >
                    {h}
                  </span>
                ))}
              </div>

              {rows.map((r, i) => (
                <div
                  key={r.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1fr 1.2fr 1fr 1fr .7fr",
                    gap: 12,
                    padding: "13px 12px",
                    borderBottom: "1px solid var(--hair2)",
                    alignItems: "center",
                    transition: "background .15s",
                    animation: "fadeUp .4s ease both",
                    animationDelay: `${Math.min(i, 12) * 45}ms`,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {r.runId ? (
                    <Link
                      href={`/${r.type}/${r.runId}`}
                      style={{
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: "var(--ink)",
                        textDecoration: "none",
                      }}
                    >
                      {r.name}
                    </Link>
                  ) : (
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
                      {r.name}
                    </span>
                  )}
                  <span>
                    <Tag>{r.type === "school" ? "SCHOOL" : "CHURCH"}</Tag>
                  </span>
                  <span
                    style={{ fontSize: 13, color: "var(--sec)", fontVariantNumeric: "tabular-nums" }}
                  >
                    {r.started}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
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
                      <button
                        type="button"
                        onClick={() => downloadCsv(r.type, r.runId!)}
                        className="mono"
                        style={{
                          fontWeight: 700,
                          fontSize: 11,
                          color: "var(--navy)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        CSV ↓
                      </button>
                    )}
                    {r.queueJobId != null && (
                      <button
                        type="button"
                        onClick={async () => {
                          await cancelQueueJob(r.type, r.queueJobId!);
                          load();
                        }}
                        className="mono"
                        style={{
                          fontWeight: 700,
                          fontSize: 11,
                          color: "var(--mute)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        CANCEL
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Page>
  );
}
