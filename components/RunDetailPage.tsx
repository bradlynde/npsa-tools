"use client";
// @ts-nocheck

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { COLORS, SCRAPER_LABELS } from "../lib/constants";
import { fetchPipelineStatus, downloadCsv, archiveRun, stopRun } from "../lib/api";
import StatCard from "./StatCard";
import ProgressBar from "./ProgressBar";
import CountyTable from "./CountyTable";
import StatusBadge from "./StatusBadge";
import type { ScraperType, PipelineStatus, CountyTask } from "../lib/types";

function formatState(state: string): string {
  return state.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export default function RunDetailPage({ runId, scraperType }: { runId: string; scraperType: ScraperType }) {
  const labels = SCRAPER_LABELS[scraperType];
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  }, [runId, scraperType]);

  // Poll if running
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!status || (status.status !== "running" && status.status !== "finalizing")) return;
    pollRef.current = setInterval(load, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.status]);

  const handleDownload = async () => {
    try {
      await downloadCsv(scraperType, runId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed");
    }
  };

  const handleArchive = async () => {
    if (!confirm("Archive this run?")) return;
    try {
      await archiveRun(scraperType, runId);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Archive failed");
    }
  };

  const handleStop = async () => {
    if (!confirm("Stop this run? This cannot be undone.")) return;
    try {
      await stopRun(scraperType, runId);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Stop failed");
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "40px 48px" }}>
        <div style={{ fontSize: 13, color: COLORS.textMuted }}>Loading run details...</div>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div style={{ padding: "40px 48px" }}>
        <Link href={`/${scraperType}`} style={{ fontSize: 13, color: COLORS.textMuted, textDecoration: "none", marginBottom: 20, display: "inline-block" }}>
          &larr; Back to {labels.title}
        </Link>
        <div style={{ background: COLORS.errorBg, color: COLORS.error, padding: "16px 20px", borderRadius: 12, fontSize: 14 }}>
          {error || "Run not found"}
        </div>
      </div>
    );
  }

  const isActive = status.status === "running" || status.status === "finalizing";
  const totalCounties = status.totalCounties ?? status.total_counties ?? 0;
  const countiesDone = status.countiesProcessed ?? status.counties_processed ?? 0;
  const totalContacts = status.totalContacts ?? status.total_contacts ?? 0;
  const withEmail = status.totalContactsWithEmails ?? status.total_contacts_with_emails ?? 0;
  const withoutEmail = totalContacts - withEmail;
  const counties: CountyTask[] = status.countyTasks || [];
  const stateName = status.state ? formatState(status.state) : "Unknown";

  return (
    <div className="page-container" style={{ padding: "28px 36px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Back link */}
      <Link className="animate-in mono" href={`/${scraperType}`} style={{ fontSize: 11.5, letterSpacing: ".06em", color: "var(--mute)", textDecoration: "none", marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 5 }}>
        &larr; back to scraper
      </Link>

      {/* Header */}
      <div className="animate-in delay-1 header-responsive" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h1 className="headline" style={{ fontSize: 30 }}>
            {stateName} <em>{labels.plural}</em>
          </h1>
          <StatusBadge status={status.status} />
        </div>
        <div className="btn-row-responsive" style={{ display: "flex", gap: 10 }}>
          {isActive && (
            <button onClick={handleStop} style={{
              background: "none", border: "1.5px solid var(--err-fg)", borderRadius: 999,
              padding: "9px 18px", fontSize: 13, color: "var(--err-fg)", cursor: "pointer", fontWeight: 700, font: "inherit",
            }}>
              Stop Run
            </button>
          )}
          {!isActive && (
            <>
              <button onClick={handleDownload} style={{
                background: "var(--navy)", border: "none", borderRadius: 999,
                padding: "10px 20px", fontSize: 13, color: "var(--on-accent)", cursor: "pointer", fontWeight: 700, font: "inherit",
                transition: "all 0.2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(30,58,95,0.3)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
              >
                Download CSV
              </button>
              <button onClick={handleArchive} style={{
                background: "none", border: "1px solid var(--bd2)", borderRadius: 999,
                padding: "10px 20px", fontSize: 13, color: "var(--sec)", cursor: "pointer", fontWeight: 700, font: "inherit",
              }}>
                Archive
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar (if active) */}
      {isActive && (
        <div style={{ marginBottom: 20 }}>
          <ProgressBar completed={countiesDone} total={totalCounties} />
        </div>
      )}

      {/* Stats */}
      <div className="animate-in delay-2 grid-responsive" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Contacts" value={totalContacts} />
        <StatCard label="Counties" value={`${countiesDone} / ${totalCounties}`} />
        <StatCard label="Run ID" value={runId.substring(0, 8)} subtitle={runId} />
      </div>

      {/* County Table */}
      {counties.length > 0 && (
        <div className="animate-in delay-3">
          <h3 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
            County Breakdown
          </h3>
          <CountyTable counties={counties} scraperType={scraperType} />
        </div>
      )}
    </div>
  );
}
