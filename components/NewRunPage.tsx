"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { US_STATES, SCRAPER_LABELS } from "../lib/constants";
import { Page, Card, Button } from "./ui";
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
        router.push("/scraper");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start pipeline");
      setStarting(false);
    }
  };

  return (
    <Page>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <Link href="/scraper" className="btn btn-quiet btn-sm" style={{ marginLeft: -10, marginBottom: 16 }}>
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> Back to Scraper
        </Link>

        <Card style={{ padding: 24 }}>
          <div className="eyebrow" style={{ color: "var(--olive-ink)", marginBottom: 6 }}>Scraper · {labels.plural.toLowerCase()}</div>
          <h1 className="headline" style={{ fontSize: 28, lineHeight: "36px", marginBottom: 20 }}>Start a new run</h1>

          <div style={{ marginBottom: 20 }}>
            <label htmlFor="new-run-state" className="eyebrow" style={{ display: "block", color: "var(--sec)", marginBottom: 6 }}>
              State
            </label>
            <select
              id="new-run-state"
              className="field"
              value={selectedState}
              onChange={(e) => { setSelectedState(e.target.value); setQueued(null); }}
              style={{ height: 40 }}
            >
              <option value="">Choose a state…</option>
              {US_STATES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <div role="alert" style={{ background: "var(--err-bg)", color: "var(--err-fg)", border: "1px solid var(--err-line)", padding: "10px 14px", borderRadius: "var(--r-md)", fontSize: 14, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {queued && (
            <div role="status" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", padding: "14px 16px", borderRadius: "var(--r-md)", fontSize: 14, lineHeight: "20px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontWeight: 600 }}>Queued, position {queued.position}</div>
              <div>Another run is going. This one starts on its own when a slot opens.</div>
              <Link href="/scraper" style={{ color: "var(--navy)", fontWeight: 500, textDecoration: "none", marginTop: 2, display: "inline-flex", alignItems: "center", gap: 4 }}>
                See it in the Scraper <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
              </Link>
            </div>
          )}

          <Button block size="lg" onClick={handleStart} disabled={!selectedState || starting} busy={starting}>
            {starting ? "Starting…" : queued ? "Queue another state" : "Start run"}
          </Button>
        </Card>
      </div>
    </Page>
  );
}
