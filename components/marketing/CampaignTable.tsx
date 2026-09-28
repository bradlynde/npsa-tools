"use client";

import { Card, Note, fmtMoney } from "../ui";

export type CampaignAgg = {
  campaign: string;
  /** False for a source row -- direct, referral, organic -- which is not a campaign
   *  and should not read like one sitting in the same list. */
  isCampaign: boolean;
  booked: number;
  held: number;
  loes: number;
  fees: number;
};

const COLS = "2fr 1fr 1fr 1fr 1.2fr";

/** By Campaign & Source — the leadership view of where bookings originate. */
export default function CampaignTable({
  rows,
  rangeWord,
  loading,
}: {
  rows: CampaignAgg[];
  rangeWord: string;
  loading: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.booked));
  const campaignCount = rows.filter((r) => r.isCampaign).length;
  const sourceCount = rows.length - campaignCount;

  return (
    <Card style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h3 className="section-title">By campaign and source</h3>
          <span className="meta">{rangeWord.charAt(0).toUpperCase() + rangeWord.slice(1)}</span>
        </div>
        {/* Count the campaigns, not the rows. Source rows sit in this table too, and
            calling all of them campaigns overstated how many were running -- it read
            "15 campaigns" when one of those was the catch-all for everything that
            was not a campaign at all. */}
        <span className="meta">
          {campaignCount} {campaignCount === 1 ? "campaign" : "campaigns"}
          {sourceCount > 0 ? ` · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : ""}
        </span>
      </div>

      {loading ? (
        <Note>Loading…</Note>
      ) : rows.length === 0 ? (
        <Note>No campaign data in this range.</Note>
      ) : (
        <div style={{ overflowX: "auto" }} className="table-responsive">
          <div style={{ minWidth: 560 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 12,
                padding: "10px 12px",
                borderBottom: "1px solid var(--hair)",
              }}
            >
              {["Campaign", "Booked", "Held", "LOEs", "LOE value"].map((h, i) => (
                <span
                  key={h}
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    lineHeight: "16px",
                    color: "var(--sec)",
                    textAlign: i === 0 ? "left" : "right",
                  }}
                >
                  {h}
                </span>
              ))}
            </div>

            {rows.map((c, i) => (
              <div
                key={c.campaign}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: 12,
                  padding: "13px 12px",
                  borderBottom: "1px solid var(--hair2)",
                  alignItems: "center",
                  animation: "fadeUp .4s ease both",
                  animationDelay: `${Math.min(i, 12) * 45}ms`,
                }}
              >
                <div>
                  <div
                    style={{
                      fontWeight: c.isCampaign ? 500 : 400,
                      color: c.isCampaign ? "var(--ink)" : "var(--sec)",
                      fontSize: 14,
                    }}
                  >
                    {c.campaign}
                  </div>
                  <div
                    style={{
                      height: 5,
                      borderRadius: 999,
                      marginTop: 7,
                      background: "var(--track)",
                      overflow: "hidden",
                      maxWidth: 220,
                    }}
                  >
                    <div
                      style={{
                        width: `${(c.booked / max) * 100}%`,
                        height: "100%",
                        background: c.isCampaign ? "var(--olive)" : "var(--bd2)",
                        transformOrigin: "left",
                        animation: "growX .7s cubic-bezier(.2,.8,.2,1) both",
                      }}
                    />
                  </div>
                </div>
                <span
                  style={{
                    textAlign: "right",
                    fontWeight: 600,
                    color: "var(--ink)",
                    fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.booked}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "var(--sec)",
                    fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.held}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "var(--sec)",
                    fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.loes}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    fontWeight: 600,
                    color: "var(--olive-ink)",
                    fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.fees ? fmtMoney(c.fees) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
