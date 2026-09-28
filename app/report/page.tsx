"use client";

import { useCallback, useEffect, useState } from "react";
import { Page, Card, PageHeading, Eyebrow, Skeleton } from "../../components/ui";
import SalesBand from "../../components/marketing/SalesBand";
import {
  fetchStats,
  fetchApplicationStats,
  fetchSalesTimeseries,
  fetchSyncStatus,
  type Stats,
  type ApplicationStats,
  type SalesGranularity,
  type SalesPoint,
  type SyncStatus,
} from "../../lib/marketing";

const todayLine = () =>
  new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

/**
 * The Company Report: the sales side of the business, all-time, from Salesforce.
 *
 * Bookings, attribution and the funnel are on the Marketing page, which runs on
 * a date range of its own. There is no Refresh button here: that button re-checks
 * bookings against Calendly and Instantly, which changes nothing on this page, and
 * the Salesforce figures sync on their own schedule (the sync line says when).
 */
export default function CompanyReportPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [apps, setApps] = useState<ApplicationStats | null>(null);
  const [salesSeries, setSalesSeries] = useState<SalesPoint[]>([]);
  const [salesGran, setSalesGran] = useState<SalesGranularity>("month");
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [s, a, sy] = await Promise.allSettled([fetchStats(), fetchApplicationStats(), fetchSyncStatus()]);
    if (s.status === "fulfilled") setStats(s.value);
    else setError((s.reason as Error)?.message || "Could not load the figures");
    // Applications live in a newer backend; absence just hides that part.
    if (a.status === "fulfilled") setApps(a.value);
    if (sy.status === "fulfilled") setSync(sy.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetchSalesTimeseries(salesGran)
      .then(setSalesSeries)
      .catch(() => setSalesSeries([]));
  }, [salesGran]);

  return (
    <Page>
      <div style={{ marginBottom: 28 }}>
        <PageHeading hero eyebrow={`Company Report · ${todayLine()}`}>
          The business, <em>up front.</em>
        </PageHeading>
      </div>

      {error && (
        <Card style={{ marginBottom: 16, borderColor: "var(--err-line)", background: "var(--err-bg)" }}>
          <Eyebrow color="var(--err-fg)" style={{ marginBottom: 4, fontWeight: 600 }}>
            Figures unavailable
          </Eyebrow>
          <div style={{ fontSize: 14, lineHeight: "20px", color: "var(--sec)" }}>
            {error}. The Sales Toolbox backend may be unreachable. The rest of the toolbox is unaffected.
          </div>
        </Card>
      )}

      {loading && <Skeleton rows={4} />}

      {/* Organisations won, contract value, grant applications */}
      {stats && (
        <SalesBand
          stats={stats}
          apps={apps}
          series={salesSeries}
          gran={salesGran}
          onGranChange={setSalesGran}
          sync={sync}
        />
      )}
    </Page>
  );
}
