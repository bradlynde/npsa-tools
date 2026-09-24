"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Archive, Download, Square } from "lucide-react";
import { SCRAPER_LABELS } from "../lib/constants";
import { fetchPipelineStatus, downloadCsv, archiveRun, stopRun } from "../lib/api";
import { Page, Button, Skeleton, useConfirm, useToast } from "./ui";
import StatCard from "./StatCard";
import ProgressBar from "./ProgressBar";
import CountyTable from "./CountyTable";
import StatusBadge from "./StatusBadge";
import type { ScraperType, PipelineStatus, CountyTask } from "../lib/types";

function formatState(state: string): string {
  return state.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function BackLink() {
  return (
    <Link href="/scraper" className="btn btn-quiet btn-sm" style={{ marginLeft: -10, marginBottom: 16 }}>
      <ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> Back to Scraper
    </Link>
  );
}

export default function RunDetailPage({ runId, scraperType }: { runId: string; scraperType: ScraperType }) {
  const labels = SCRAPER_LABELS[scraperType];
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "archive" | "stop" | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [toast, notify] = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const data = await fetchPipelineStatus(scraperType, runId);
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load run details");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [runId, scraperType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while the run is going.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!status || (status.status !== "running" && status.status !== "finalizing")) return;
    pollRef.current = setInterval(load, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (kind: "download" | "archive" | "stop", fn: () => Promise<unknown>, done?: string) => {
    setBusy(kind);
    setActionError(null);
    try {
      await fn();
      if (done) notify(done);
      if (kind !== "download") load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : `${kind.charAt(0).toUpperCase() + kind.slice(1)} failed`);
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = () => act("download", () => downloadCsv(scraperType, runId));

  const handleArchive = async () => {
    const ok = await confirm({
      title: "Archive this run?",
      body: "It leaves the Scraper's run list. Nothing is deleted.",
      confirmLabel: "Archive run",
    });
    if (ok) act("archive", () => archiveRun(scraperType, runId), "Run archived");
  };

  const handleStop = async () => {
    const ok = await confirm({
      title: "Stop this run?",
      body: "Counties not searched yet will be skipped, and the run can't be restarted from here.",
      confirmLabel: "Stop run",
      tone: "danger",
    });
    if (ok) act("stop", () => stopRun(scraperType, runId), "Run stopped");
  };

  if (loading) {
    return (
      <Page>
        <BackLink />
        <Skeleton rows={5} />
      </Page>
    );
  }

  if (error || !status) {
    return (
      <Page>
        <BackLink />
        <div role="alert" style={{ background: "var(--err-bg)", color: "var(--err-fg)", border: "1px solid var(--err-line)", padding: "14px 18px", borderRadius: "var(--r-md)", fontSize: 14 }}>
          {error || "Run not found"}
        </div>
      </Page>
    );
  }

  const isActive = status.status === "running" || status.status === "finalizing";
  const totalCounties = status.totalCounties ?? status.total_counties ?? 0;
  const countiesDone = status.countiesProcessed ?? status.counties_processed ?? 0;
  const totalContacts = status.totalContacts ?? status.total_contacts ?? 0;
  const withEmail = status.totalContactsWithEmails ?? status.total_contacts_with_emails ?? 0;
  const counties: CountyTask[] = status.countyTasks || [];
  const stateName = status.state ? formatState(status.state) : "Unknown";
  const emailPct = totalContacts > 0 ? Math.round((withEmail / totalContacts) * 100) : 0;

  return (
    <Page>
      <BackLink />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div className="eyebrow" style={{ color: "var(--olive-ink)" }}>
            Scraper · {labels.singular.toLowerCase()} run · <span className="mono" style={{ fontSize: 12 }} title={runId}>{runId}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 className="headline">
              {stateName} {labels.plural}
            </h1>
            <StatusBadge status={status.status} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isActive ? (
            <Button variant="danger" icon={Square} busy={busy === "stop"} disabled={!!busy} onClick={handleStop}>
              Stop run
            </Button>
          ) : (
            <>
              <Button variant="secondary" icon={Archive} busy={busy === "archive"} disabled={!!busy} onClick={handleArchive}>
                Archive
              </Button>
              <Button icon={Download} busy={busy === "download"} disabled={!!busy} onClick={handleDownload}>
                Download CSV
              </Button>
            </>
          )}
        </div>
      </div>

      {actionError && (
        <div role="alert" style={{ marginBottom: 16, padding: "12px 16px", borderRadius: "var(--r-md)", border: "1px solid var(--err-line)", background: "var(--err-bg)", color: "var(--err-fg)", fontSize: 14 }}>
          {actionError}
        </div>
      )}

      {/* Progress, while it runs */}
      {isActive && (
        <div className="card-surface" style={{ marginBottom: 16, padding: "18px 20px", background: "var(--card)", border: "1px solid var(--bd2)", borderRadius: "var(--r-lg)" }}>
          <ProgressBar completed={countiesDone} total={totalCounties} label="Progress" />
        </div>
      )}

      {/* Figures */}
      <div className="grid-responsive" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 28 }}>
        <StatCard label="Contacts" value={totalContacts} subtitle={isActive ? "Found so far" : "Found in this run"} />
        <StatCard label="With an email" value={withEmail} subtitle={totalContacts ? `${emailPct}% of contacts` : "None yet"} />
        <StatCard label="Counties" value={`${countiesDone} of ${totalCounties}`} subtitle={isActive ? "Searched so far" : "Searched"} />
      </div>

      {/* Counties */}
      {counties.length > 0 && (
        <div>
          <h2 className="section-title" style={{ marginBottom: 12 }}>
            Counties
          </h2>
          <CountyTable counties={counties} scraperType={scraperType} />
        </div>
      )}
      {confirmDialog}
      {toast}
    </Page>
  );
}
