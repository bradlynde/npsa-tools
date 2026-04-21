"use client";
// @ts-nocheck

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { COLORS, SCRAPER_LABELS } from "../lib/constants";
import { fetchRuns, fetchPipelineStatus, stopRun, fetchQueue, cancelQueueJob } from "../lib/api";
import StatCard from "./StatCard";
import ProgressBar from "./ProgressBar";
import RunsTable from "./RunsTable";
import StatusBadge from "./StatusBadge";
import type { RunMetadata, ScraperType, PipelineStatus, QueueJob } from "../lib/types";

export default function ScraperDashboard({ scraperType }: { scraperType: ScraperType }) {
  const labels = SCRAPER_LABELS[scraperType];
  const [runs, setRuns] = useState<RunMetadata[]>([]);
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeStatus, setActiveStatus] = useState<PipelineStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRuns = async () => {
    try {
      const data = await fetchRuns(scraperType, showArchived);
      setRuns(data);
    } catch {
      setRuns(prev => prev.length > 0 ? prev : []);
    }
    setLoading(false);
  };

  const loadQueue = useCallback(async () => {
    try {
      const jobs = await fetchQueue(scraperType);
      setQueueJobs(jobs);
    } catch {
      setQueueJobs([]);
    }
  }, [scraperType]);

  useEffect(() => {
    loadRuns();
    loadQueue();
  }, [scraperType, showArchived]);

  // Find active run and poll for updates
  const activeRun = runs.find(r => r.status === "running" || r.status === "finalizing");

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!activeRun) {
      setActiveStatus(null);
      return;
    }

    const poll = async () => {
      try {
        const status = await fetchPipelineStatus(scraperType, activeRun.run_id);
        setActiveStatus(status);
      } catch {
        // ignore
      }
    };
    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeRun?.run_id, scraperType]);

  // Poll queue every 30s
  useEffect(() => {
    const interval = setInterval(loadQueue, 30000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  const handleStop = async () => {
    if (!activeRun) return;
    if (!confirm("Stop this run? This cannot be undone.")) return;
    try {
      await stopRun(scraperType, activeRun.run_id);
      loadRuns();
      loadQueue();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to stop run");
    }
  };

  const handleCancelJob = async (jobId: number) => {
    try {
      await cancelQueueJob(scraperType, jobId);
      loadQueue();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove from queue");
    }
  };

  const completedRuns = runs.filter(r => r.status === "done" || r.status === "completed");
  const totalContacts = completedRuns.reduce((s, r) => s + (r.total_contacts || 0), 0);
  const totalWithEmail = completedRuns.reduce((s, r) => s + (r.total_contacts_with_emails || 0), 0);
  const statesScraped = new Set(completedRuns.map(r => r.state)).size;

  const nonArchivedRuns = runs.filter(r => !r.archived && r.status !== "running" && r.status !== "finalizing");

  // Active run stats from polling
  const as = activeStatus;
  const activeCountiesTotal = as?.totalCounties ?? as?.total_counties ?? 0;
  const activeCountiesDone = as?.countiesProcessed ?? as?.counties_processed ?? 0;
  const activeContacts = as?.totalContacts ?? as?.total_contacts ?? 0;
  const activeWithEmail = as?.totalContactsWithEmails ?? as?.total_contacts_with_emails ?? 0;

  if (loading) {
    return (
      <div className="page-container" style={{ padding: "40px 48px" }}>
        <div style={{ fontSize: 13, color: COLORS.textMuted }}>Loading...</div>
      </div>
    );
  }

  return (
    <div className="page-container" style={{ padding: "28px 36px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div className="animate-in header-responsive" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, margin: 0, letterSpacing: "-0.02em" }}>
          {labels.title}
        </h1>
        <Link
          href={`/${scraperType}/new`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 16px", background: scraperType === "church" ? COLORS.accent : COLORS.green, color: "#fff",
            borderRadius: 8, textDecoration: "none", fontSize: 12, fontWeight: 600,
            transition: "all 0.2s",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(30,58,95,0.3)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
        >
          + New Run
        </Link>
      </div>

      {/* Active Run */}
      {activeRun && (
        <div className="animate-in delay-1" style={{
          background: COLORS.cardBg, borderRadius: 12, padding: "20px 24px",
          boxShadow: COLORS.cardShadow, border: `1px solid ${COLORS.cardBorder}`,
          marginBottom: 20,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
                Current Run
              </h3>
              <StatusBadge status={activeRun.status} />
              <span style={{ fontSize: 13, color: COLORS.textSecondary }}>
                {activeRun.display_name || activeRun.state?.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
              </span>
            </div>
            <button
              onClick={handleStop}
              style={{
                background: "none", border: `1px solid ${COLORS.error}`, borderRadius: 6,
                padding: "6px 14px", fontSize: 12, color: COLORS.error, cursor: "pointer", fontWeight: 500,
              }}
            >
              Stop Run
            </button>
          </div>

          <ProgressBar completed={activeCountiesDone} total={activeCountiesTotal} />

          <div className="grid-responsive" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginTop: 16 }}>
            <StatCard label="Counties Done" value={`${activeCountiesDone} / ${activeCountiesTotal}`} />
            <StatCard label="Contacts Found" value={activeContacts} />
          </div>

          <div style={{ marginTop: 12, textAlign: "right" }}>
            <Link
              href={`/${scraperType}/${activeRun.run_id}`}
              style={{ fontSize: 12, color: COLORS.accent, textDecoration: "none", fontWeight: 500 }}
            >
              View Details &rarr;
            </Link>
          </div>
        </div>
      )}

      {/* Queue */}
      {queueJobs.length > 0 && (
        <div style={{
          background: COLORS.cardBg, borderRadius: 12, padding: "20px 24px",
          boxShadow: COLORS.cardShadow, border: `1px solid ${COLORS.cardBorder}`,
          marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
              Queue
            </h3>
            <span style={{
              fontSize: 11, fontWeight: 600, background: COLORS.warningBg, color: COLORS.warning,
              padding: "2px 8px", borderRadius: 12,
            }}>
              {queueJobs.length} {queueJobs.length === 1 ? 'job' : 'jobs'}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {queueJobs.map((job, idx) => (
              <div key={job.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 16px", borderRadius: 8,
                background: "#fafafa", border: "1px solid #eee",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%", background: COLORS.warningBg,
                    color: COLORS.warning, fontSize: 11, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {idx + 1}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                    {job.display_name || job.state?.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                  </span>
                  <StatusBadge status="queued" />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {job.created_at && (
                    <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                      {new Date(job.created_at).toLocaleString("en-US", {
                        timeZone: "America/Chicago", month: "short", day: "numeric",
                        hour: "numeric", minute: "2-digit", hour12: true,
                      })}
                    </span>
                  )}
                  <button
                    onClick={() => handleCancelJob(job.id)}
                    title="Remove from queue"
                    style={{
                      background: "none", border: "none", cursor: "pointer", padding: 4,
                      color: COLORS.textMuted, transition: "color 0.15s",
                      display: "flex", alignItems: "center",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = COLORS.error)}
                    onMouseLeave={e => (e.currentTarget.style.color = COLORS.textMuted)}
                  >
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: COLORS.textMuted }}>
            Jobs run automatically in order when the current run finishes.
          </div>
        </div>
      )}

      {/* Aggregated Stats */}
      <div className="animate-in delay-2 grid-responsive" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Total Contacts" value={totalContacts} />
        <StatCard label="States Scraped" value={statesScraped} />
      </div>

      {/* Previous Runs */}
      <div className="animate-in delay-3" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
            Previous Runs
          </h3>
        </div>
        <RunsTable runs={nonArchivedRuns} scraperType={scraperType} onArchive={loadRuns} />
      </div>

      {/* Archive Link */}
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <button
          onClick={() => setShowArchived(!showArchived)}
          style={{
            background: "none", border: "none", fontSize: 12,
            color: COLORS.textMuted, cursor: "pointer", textDecoration: "underline",
          }}
        >
          {showArchived ? "Hide archived runs" : "View archived runs"}
        </button>
      </div>
    </div>
  );
}
