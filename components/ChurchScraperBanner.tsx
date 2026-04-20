"use client";

import { COLORS } from "../lib/constants";

// --- TEMPORARY: REMOVE THIS FILE (and its imports) WHEN OPENAI QUOTA IS RESTORED ---
// Added 2026-04-20: Church scraper's OpenAI quota is exhausted. Every LLM
// filter call returns 429, causing every run to produce 0 contacts while
// still burning Google Places API budget (~$130/state for Texas-sized).
// Until the OpenAI key is topped up, the church scraper must not be used.
// ------------------------------------------------------------------------------------

export const CHURCH_SCRAPER_DISABLED = true;

export default function ChurchScraperBanner() {
  if (!CHURCH_SCRAPER_DISABLED) return null;

  return (
    <div
      role="alert"
      style={{
        background: COLORS.errorBg,
        border: `1px solid ${COLORS.error}`,
        borderLeft: `4px solid ${COLORS.error}`,
        borderRadius: 8,
        padding: "14px 18px",
        marginBottom: 20,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 18,
          lineHeight: 1,
          color: COLORS.error,
          flexShrink: 0,
          marginTop: 1,
        }}
        aria-hidden
      >
        ⚠
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: COLORS.error,
            marginBottom: 4,
          }}
        >
          Church Scraper Temporarily Disabled
        </div>
        <div style={{ fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.5 }}>
          The OpenAI API quota is exhausted. Church runs cannot be started — any
          attempt would produce 0 contacts while still spending Google Places API
          credits. Existing completed runs and CSVs are unaffected. School scraper
          is operating normally.
        </div>
      </div>
    </div>
  );
}
