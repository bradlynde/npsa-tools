"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { COLORS, US_STATES, SCRAPER_LABELS } from "../lib/constants";
import { startPipeline } from "../lib/api";
import type { ScraperType } from "../lib/types";

export default function NewRunPage({ scraperType }: { scraperType: ScraperType }) {
  const labels = SCRAPER_LABELS[scraperType];
  const router = useRouter();
  const [selectedState, setSelectedState] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ jobId: number; position: number } | null>(null);

  const handleStart = async () => {
    if (!selectedState) return;
    setStarting(true);
    setError(null);
    setQueued(null);
    try {
      const result = await startPipeline(scraperType, selectedState);

      if (result.status === "queued") {
        setQueued({ jobId: result.jobId!, position: result.position! });
        setStarting(false);
      } else {
        router.push(`/${scraperType}`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start pipeline");
      setStarting(false);
    }
  };

  return (
    <div className="page-container" style={{
      padding: "28px 36px",
      maxWidth: 560,
      margin: "0 auto",
    }}>
      <Link
        className="animate-in"
        href={`/${scraperType}`}
        style={{ fontSize: 13, color: COLORS.textMuted, textDecoration: "none", marginBottom: 20, display: "inline-block" }}
      >
        &larr; Back to {labels.title}
      </Link>

      <div className="animate-in delay-1" style={{
        background: COLORS.cardBg,
        borderRadius: 12,
        padding: "32px",
        boxShadow: COLORS.cardShadow,
        border: `1px solid ${COLORS.cardBorder}`,
      }}>
        <div style={{ fontSize: 12, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 6 }}>
          {labels.title}
        </div>
        <h2 style={{ margin: "0 0 24px", fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, letterSpacing: "-0.02em" }}>
          Start New Run
        </h2>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 13, color: COLORS.textSecondary, display: "block", marginBottom: 6, fontWeight: 500 }}>
            Select State
          </label>
          <select
            value={selectedState}
            onChange={e => { setSelectedState(e.target.value); setQueued(null); }}
            style={{
              width: "100%",
              padding: "10px 14px",
              fontSize: 14,
              borderRadius: 8,
              border: `1px solid ${COLORS.cardBorder}`,
              background: "#fff",
              color: COLORS.textPrimary,
              outline: "none",
              boxSizing: "border-box",
              appearance: "auto",
            }}
          >
            <option value="">Choose a state...</option>
            {US_STATES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {error && (
          <div style={{
            background: COLORS.errorBg,
            color: COLORS.error,
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {queued && (
          <div style={{
            background: COLORS.warningBg,
            color: COLORS.warning,
            padding: "14px 16px",
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Queued — Position {queued.position}
            </div>
            <div>
              Another run is currently active. This job has been added to the queue
              and will start automatically when a slot opens.
            </div>
            <Link
              href={`/${scraperType}`}
              style={{ color: COLORS.accent, fontWeight: 500, textDecoration: "none", marginTop: 4 }}
            >
              View dashboard &rarr;
            </Link>
          </div>
        )}

        <button
          onClick={handleStart}
          disabled={!selectedState || starting}
          style={{
            width: "100%",
            padding: "12px",
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 8,
            border: "none",
            background: selectedState && !starting ? COLORS.accent : "#ccc",
            color: "#fff",
            cursor: selectedState && !starting ? "pointer" : "not-allowed",
            transition: "background 0.15s ease",
          }}
        >
          {starting ? "Starting..." : queued ? "Queue Another State" : "Start Run"}
        </button>
      </div>
    </div>
  );
}
