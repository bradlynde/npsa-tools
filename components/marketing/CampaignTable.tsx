"use client";

import { Card, Eyebrow, Note, fmtMoney } from "../ui";

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
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <Eyebrow>by campaign &amp; source — {rangeWord}</Eyebrow>
        {/* Count the campaigns, not the rows. Source rows sit in this table too, and
            calling all of them campaigns overstated how many were running -- it read
            "15 campaigns" when one of those was the catch-all for everything that
            was not a campaign at all. */}
        <Eyebrow color="var(--faint)">
          {campaignCount} {campaignCount === 1 ? "campaign" : "campaigns"}
          {sourceCount > 0 ? ` · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : ""}
        </Eyebrow>
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
              {["CAMPAIGN", "BOOKED", "HELD", "LOES", "LOE $"].map((h, i) => (
                <span
                  key={h}
                  className="mono"
                  style={{
                    fontWeight: 600,
                    fontSize: 10.5,
                    letterSpacing: ".07em",
                    color: "var(--faint)",
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
                      fontWeight: c.isCampaign ? 600 : 500,
                      color: c.isCampaign ? "var(--ink)" : "var(--sec)",
                      fontSize: 13.5,
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
                        animation: "growX .9s cubic-bezier(.34,1.3,.4,1) both",
                      }}
                    />
                  </div>
                </div>
                <span
                  style={{
                    textAlign: "right",
                    fontWeight: 700,
                    color: "var(--ink)",
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.booked}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "var(--sec)",
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.held}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "var(--sec)",
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.loes}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    fontWeight: 700,
                    color: "var(--olive)",
                    fontSize: 13,
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
