// @ts-nocheck
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { COLORS } from "../lib/constants";
import { fetchRuns } from "../lib/api";
import MetricCards from "../components/MetricCards";
import ActivePipelineHero from "../components/ActivePipelineHero";
import type { RunMetadata } from "../lib/types";

// Lazy-load USStateMap (large SVG component)
import dynamic from "next/dynamic";
const USStateMap = dynamic(() => import("../components/USStateMap"), { ssr: false });

function formatState(state: string): string {
  return state.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export default function HomePage() {
  const [churchRuns, setChurchRuns] = useState<RunMetadata[]>([]);
  const [schoolRuns, setSchoolRuns] = useState<RunMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [cr, sr] = await Promise.allSettled([
          fetchRuns("church"),
          fetchRuns("school"),
        ]);
        if (cr.status === "fulfilled") setChurchRuns(cr.value);
        if (sr.status === "fulfilled") setSchoolRuns(sr.value);
      } catch {
        // ignore
      }
      setLoading(false);
    }
    load();
  }, []);

  const allRuns = [...churchRuns, ...schoolRuns];
  const activeRuns = allRuns.filter(
    (r) => r.status === "running" || r.status === "finalizing"
  );

  // Build state data for the map from API results
  const stateData: Record<string, any> = {};
  const completedRuns = allRuns.filter(
    (r) => r.status === "done" || r.status === "completed"
  );
  for (const run of completedRuns) {
    const key = run.state?.toLowerCase().replace(/\s+/g, "_");
    if (!key) continue;
    if (!stateData[key]) stateData[key] = { state: key };
    const type = run.scraper_type || "church";
    if (type === "church" && !stateData[key].churchRun) {
      stateData[key].churchRun = {
        total_contacts: run.total_contacts || 0,
        total_counties: run.total_counties || 0,
        completed_at: run.completed_at || run.created_at || "",
        display_name: run.display_name || formatState(key),
      };
    }
    if (type === "school" && !stateData[key].schoolRun) {
      stateData[key].schoolRun = {
        total_contacts: run.total_contacts || 0,
        total_counties: run.total_counties || 0,
        completed_at: run.completed_at || run.created_at || "",
        display_name: run.display_name || formatState(key),
      };
    }
  }

  // Also include running runs in stateData for visual coverage
  for (const run of activeRuns) {
    const key = run.state?.toLowerCase().replace(/\s+/g, "_");
    if (!key) continue;
    if (!stateData[key]) stateData[key] = { state: key };
    const type = run.scraper_type || "church";
    if (type === "church" && !stateData[key].churchRun) {
      stateData[key].churchRun = {
        total_contacts: run.total_contacts || 0,
        total_counties: run.total_counties || 0,
        completed_at: "In Progress",
        display_name: run.display_name || formatState(key),
      };
    }
    if (type === "school" && !stateData[key].schoolRun) {
      stateData[key].schoolRun = {
        total_contacts: run.total_contacts || 0,
        total_counties: run.total_counties || 0,
        completed_at: "In Progress",
        display_name: run.display_name || formatState(key),
      };
    }
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  if (loading) {
    return (
      <div style={{ padding: "40px 48px", display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ fontSize: 13, color: COLORS.textMuted }}>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="page-container" style={{ padding: "28px 36px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div className="animate-in header-responsive" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, margin: 0, letterSpacing: "-0.02em" }}>
            Dashboard
          </h1>
          <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{today}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link
            href="/church/new"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              background: COLORS.accent,
              color: "#fff",
              borderRadius: 8,
              textDecoration: "none",
              fontSize: 12,
              fontWeight: 600,
              transition: "all 0.2s",
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(30,58,95,0.3)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
          >
            + Church Run
          </Link>
          <Link
            href="/school/new"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              background: COLORS.green,
              color: "#fff",
              borderRadius: 8,
              textDecoration: "none",
              fontSize: 12,
              fontWeight: 600,
              transition: "all 0.2s",
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(107,142,35,0.3)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
          >
            + School Run
          </Link>
        </div>
      </div>

      {/* Active Pipeline Hero — collapses when no active runs */}
      {activeRuns.length > 0 && (
        <div className="animate-in delay-1" style={{ marginBottom: 20 }}>
          <ActivePipelineHero activeRuns={activeRuns} />
        </div>
      )}

      {/* US State Map — main feature */}
      <div className="animate-in delay-2" style={{
        background: COLORS.cardBg,
        borderRadius: 14,
        padding: "24px 28px",
        border: `1px solid ${COLORS.cardBorder}`,
        boxShadow: COLORS.cardShadow,
        marginBottom: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
            Scraper Coverage
          </h2>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: COLORS.textMuted }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.accent, display: "inline-block" }} />
              Churches
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.green, display: "inline-block" }} />
              Schools
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#2d6a4f", display: "inline-block" }} />
              Both
            </span>
          </div>
        </div>
        <USStateMap stateData={stateData} />
      </div>

      {/* Metric Cards */}
      <div className="animate-in delay-3" style={{ marginBottom: 20 }}>
        <MetricCards
          avgDurationPerCounty="~10m"
          avgCostPerContact="$0.03"
        />
      </div>
    </div>
  );
}
