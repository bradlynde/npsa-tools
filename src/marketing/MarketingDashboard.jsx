// src/marketing/MarketingDashboard.jsx
// Self-contained Marketing dashboard. Matches the Sales Toolbox design language
// (navy #1a2540→#1a4a6e / olive #7a8c1e→#9aab2e gradients, #d8dfe8 canvas, Inter).
//
// Mount it however the app navigates. In this repo, add an appView branch:
//     import MarketingDashboard from './marketing/MarketingDashboard.jsx';
//     {appView === 'marketing' && <MarketingDashboard onBack={()=>setAppView('dashboard')} />}
// It only needs same-origin /api/marketing/* endpoints, so it also drops into
// the npsa-tools shell unchanged.

import { useState, useEffect, useRef } from 'react';

// Slot-machine count-up (mirrors App.jsx RollUp)
function RollUp({ value, format, playToken = 0, duration = 850 }) {
  const [display, setDisplay] = useState(value);
  const rafRef = useRef();
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const to = Number(value) || 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(to * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else setDisplay(to);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playToken, value, duration]);
  return <>{format ? format(display) : Math.round(display)}</>;
}

const navy = 'linear-gradient(135deg,#1a2540,#1a4a6e)';
const olive = 'linear-gradient(135deg,#7a8c1e,#9aab2e)';
const card = { background: '#fff', borderRadius: 18, boxShadow: '0 4px 16px rgba(2,6,23,0.07)', border: '1px solid rgba(255,255,255,0.8)' };
const label = { fontSize: 13, fontWeight: 800, color: '#5b6b8c', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 14 };
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const j = (p) => fetch(p).then(r => (r.ok ? r.json() : null)).catch(() => null);
// period is 'YYYY-MM-DD' (start of week/month). Weeks -> "7/13", months -> "Jul".
const CH_LABELS = { instantly: 'Instantly', google_ads: 'Google Ads', search: 'Organic Search', email: 'Email', social: 'Social', referral: 'Referral', conference: 'Conference', linkedin: 'LinkedIn', direct: 'Direct / Other', google: 'Google', organic: 'Organic' };
const chLabel = (c) => CH_LABELS[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Direct / Other');
const fmtPeriod = (period, gran) => {
  const d = new Date(period + 'T00:00:00'); // local midnight, avoids UTC off-by-one
  if (isNaN(d)) return period;
  return gran === 'month'
    ? d.toLocaleDateString('en-US', { month: 'short' })
    : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
};

// Big divider between the Sales (Salesforce) and Marketing (funnel) halves.
function SectionHead({ title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '4px 0 14px', flexWrap: 'wrap' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#1a2540', letterSpacing: -0.3 }}>{title}</div>
      <div style={{ height: 1, background: '#c6cfdc', flex: 1, minWidth: 20 }} />
      <div style={{ fontSize: 12, color: '#7a869f', fontWeight: 600 }}>{sub}</div>
    </div>
  );
}

const timeAgo = (iso) => {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

// Says how current the Salesforce numbers actually are, right where they're read.
// The dashboard pulls on a schedule, so "is this stale?" is a real question — and a
// silent failure that leaves yesterday's figures on screen is the one failure mode
// that would matter most. Better for the dashboard to state its own freshness than
// for anyone to have to trust it.
function SyncStrip({ status }) {
  if (!status) return null;
  const runs = status.runs || [];
  const failed = runs.filter(r => r.ok === false);
  const newest = runs.reduce((max, r) => (r.finished_at && r.finished_at > max ? r.finished_at : max), '');
  const stale = newest && (Date.now() - new Date(newest).getTime()) > 24 * 3600 * 1000;

  let tone, text;
  if (!status.configured) {
    tone = '#7a869f'; text = 'Salesforce sync not configured — figures are from the last manual load';
  } else if (failed.length) {
    tone = '#c2410c'; text = `Last Salesforce sync failed — ${failed[0].error || 'unknown error'}`;
  } else if (!newest) {
    tone = '#7a869f'; text = 'Salesforce sync has not run yet';
  } else {
    const seen = runs.reduce((s, r) => s + (r.rows_seen || 0), 0);
    tone = stale ? '#b45309' : '#4d7c0f';
    text = `Synced from Salesforce ${timeAgo(newest)} · ${seen.toLocaleString()} records`;
  }
  // A held-back prune is a successful run that chose not to delete — worth surfacing,
  // since the alternative is silently keeping rows the dashboard believes are gone.
  const note = runs.map(r => r.note).filter(Boolean)[0];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '-8px 0 16px', fontSize: 12.5, color: tone }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone, flexShrink: 0 }} />
      <span>{text}{note ? ` · ${note}` : ''}</span>
    </div>
  );
}

// minWidth 0 so the grid column (not the label text) decides the width — otherwise
// a long label sets a min-content floor and the whole row overflows its container.
//
// These tiles sit five-across, leaving roughly 114px of text room each, while a
// money value like "$411,500" needs ~151px at 34px — so long values used to spill
// past the tile. Size the number to its own length instead. It is measured from the
// FINAL value, not the mid-animation one, so the type doesn't jitter as it counts up.
function statFontSize(text) {
  const n = String(text).length;
  if (n <= 4) return 34;
  if (n <= 6) return 30;
  if (n <= 8) return 24;
  return 20;
}

function StatCard({ bg, value, format, sub, playToken }) {
  const [roll, setRoll] = useState(playToken || 0);
  const finalText = format ? String(format(value)) : String(Math.round(Number(value) || 0));
  return (
    <div onMouseEnter={() => setRoll(k => k + 1)}
      style={{ background: bg, borderRadius: 18, padding: '22px 24px', boxShadow: '0 10px 28px rgba(26,37,64,0.28)', cursor: 'default', minWidth: 0 }}>
      <div style={{ color: '#fff', fontWeight: 800, fontSize: statFontSize(finalText), lineHeight: 1.1, whiteSpace: 'nowrap' }}>
        <RollUp value={value} playToken={roll} format={format} />
      </div>
      <div style={{ color: 'rgba(255,255,255,0.78)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>{sub}</div>
    </div>
  );
}

export default function MarketingDashboard({ onBack }) {
  const [stats, setStats] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [byCampaign, setByCampaign] = useState([]);
  const [byChannel, setByChannel] = useState([]);
  const [series, setSeries] = useState([]);
  const [rows, setRows] = useState([]);
  const [gran, setGran] = useState('week');
  const [search, setSearch] = useState('');
  const [untracked, setUntracked] = useState([]);
  const [showUntracked, setShowUntracked] = useState(false);
  const [apps, setApps] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [showPrograms, setShowPrograms] = useState(false);
  const [salesSeries, setSalesSeries] = useState([]);
  const [salesGran, setSalesGran] = useState('month');
  const [salesMetric, setSalesMetric] = useState('new_orgs');
  const [salesCumulative, setSalesCumulative] = useState(false);
  const [metric, setMetric] = useState('booked');   // booked | held | clients | won_amount
  const [compare, setCompare] = useState(false);      // dim previous-period ghost bars
  const [winOffset, setWinOffset] = useState(0);      // periods scrolled back from newest

  const loadRows = () => j(`/api/marketing/bookings?search=${encodeURIComponent(search)}`).then(d => d && setRows(d));
  useEffect(() => {
    j('/api/marketing/stats').then(setStats);
    j('/api/marketing/funnel').then(setFunnel);
    j('/api/marketing/by-campaign').then(d => d && setByCampaign(d));
    j('/api/marketing/by-channel').then(d => d && setByChannel(d));
    j('/api/marketing/untracked-wins').then(d => d && setUntracked(d));
    j('/api/marketing/sync/status').then(setSyncStatus);
    j('/api/marketing/applications/stats').then(d => d && setApps(d));
    loadRows();
  }, []);
  useEffect(() => { j(`/api/marketing/timeseries?granularity=${gran}`).then(d => d && setSeries(d)); }, [gran]);
  useEffect(() => { j(`/api/marketing/sales-timeseries?granularity=${salesGran}`).then(d => d && setSalesSeries(d)); }, [salesGran]);

  const toggle = async (id, field, val) => {
    await fetch(`/api/marketing/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: val }) });
    loadRows(); j('/api/marketing/stats').then(setStats); j('/api/marketing/funnel').then(setFunnel);
  };

  const mom = stats ? stats.bookings_this_month - stats.bookings_last_month : 0;

  // What each bar measures (metric toggle).
  const METRICS = [
    { key: 'booked', label: 'Bookings', title: 'Bookings', money: false },
    { key: 'held', label: 'Held', title: 'Held meetings', money: false },
    { key: 'clients', label: 'LOEs', title: 'LOEs sent', money: false },
    { key: 'won_amount', label: 'Won $', title: 'Won revenue', money: true },
  ];
  const metricCfg = METRICS.find(m => m.key === metric) || METRICS[0];
  const metricVal = (s) => (s ? Number(s[metricCfg.key]) || 0 : 0);
  const fmtMetric = (v) => (metricCfg.money ? money(v) : Math.round(v).toLocaleString());

  // ── Sales trend (Salesforce wins by close date) ──
  const SALES_METRICS = [
    { key: 'new_orgs', label: 'New orgs', title: 'New organizations won', money: false },
    { key: 'amount', label: 'Contract $', title: 'Contract value', money: true },
    { key: 'contracts', label: 'Contracts', title: 'Contracts signed', money: false },
  ];
  const salesCfg = SALES_METRICS.find(m => m.key === salesMetric) || SALES_METRICS[0];
  const fmtSalesVal = (v) => (salesCfg.money ? money(v) : Math.round(v).toLocaleString());
  // Cumulative is a running total. It's only correct for orgs because the API returns
  // new_orgs (first-ever win) — summing per-period distinct orgs would double-count
  // an org that wins again later.
  const salesShown = (() => {
    const win = salesGran === 'quarter' ? 16 : 24;
    const slice = salesSeries.slice(-win);
    if (!salesCumulative) return slice.map(s => ({ ...s, v: Number(s[salesCfg.key]) || 0 }));
    // Run the total from the very start of history, not just the visible window.
    const startIdx = salesSeries.length - slice.length;
    let run = salesSeries.slice(0, startIdx).reduce((t, s) => t + (Number(s[salesCfg.key]) || 0), 0);
    return slice.map(s => { run += Number(s[salesCfg.key]) || 0; return { ...s, v: run }; });
  })();
  const salesMax = Math.max(1, ...salesShown.map(s => s.v));
  const salesTotal = salesCumulative
    ? (salesShown.length ? salesShown[salesShown.length - 1].v : 0)
    : salesShown.reduce((t, s) => t + s.v, 0);
  const fmtSalesPeriod = (p) => {
    const d = new Date(p + 'T00:00:00');
    if (isNaN(d)) return p;
    const yr = String(d.getFullYear()).slice(2);
    return salesGran === 'quarter'
      ? `Q${Math.floor(d.getMonth() / 3) + 1} '${yr}`
      : `${d.toLocaleDateString('en-US', { month: 'short' })} '${yr}`;
  };
  const salesLabelIdx = (() => {
    const n = salesShown.length, t = Math.min(6, n);
    const set = new Set();
    for (let k = 0; k < t; k++) set.add(Math.round((k * (n - 1)) / (t - 1 || 1)));
    return set;
  })();

  // Visible window: last N periods, pannable back through history with the stepper.
  const WINDOW = gran === 'week' ? 14 : 12;
  const maxOffset = Math.max(0, series.length - WINDOW);
  const off = Math.min(winOffset, maxOffset);
  const end = series.length - off;
  const start = Math.max(0, end - WINDOW);
  const shown = series.slice(start, end);
  const ghostOf = (i) => (compare ? metricVal(series[start + i - 1]) : 0); // previous period
  const maxSeries = Math.max(1, ...shown.map(metricVal), ...shown.map((_, i) => ghostOf(i)));
  const step = Math.max(1, Math.round(WINDOW / 2));
  const canOlder = off < maxOffset;
  const canNewer = off > 0;
  const rangeLabel = shown.length ? `${fmtPeriod(shown[0].period, gran)} – ${fmtPeriod(shown[shown.length - 1].period, gran)}` : '';

  // ~7 evenly-spaced x-axis labels including first & last — no cramped collisions.
  const labelIdx = (() => {
    const n = shown.length, t = Math.min(7, n);
    const set = new Set();
    for (let k = 0; k < t; k++) set.add(Math.round((k * (n - 1)) / (t - 1 || 1)));
    return set;
  })();
  const barGap = gran === 'week' ? 8 : 6;
  const barW = gran === 'week' ? '60%' : '54%';
  const ghostW = gran === 'week' ? '86%' : '78%';
  const maxCamp = Math.max(1, ...byCampaign.map(c => c.booked));

  return (
    <div style={{ minHeight: '100vh', background: '#d8dfe8', fontFamily: 'Inter,sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 920, padding: '20px 24px 0', boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {onBack ? <button onClick={onBack} style={{ background: '#fff', border: '1px solid #d0d6e0', borderRadius: 10, padding: '8px 14px', color: '#5b6b8c', cursor: 'pointer', fontWeight: 600 }}>&#8592; Back</button> : <span />}
        <button onClick={() => fetch('/api/marketing/enrich', { method: 'POST' }).then(() => window.location.reload())}
          style={{ background: '#fff', border: '1px solid #d0d6e0', borderRadius: 10, padding: '8px 14px', color: '#5b6b8c', cursor: 'pointer', fontWeight: 600 }}>Refresh data</button>
      </div>

      <div style={{ textAlign: 'center', padding: '18px 32px 16px' }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: '#1a2540', letterSpacing: -0.5 }}>Sales &amp; Marketing Dashboard</div>
        <div style={{ fontSize: 15, color: '#5b6b8c', marginTop: 6 }}>What we've won, and what's driving it.</div>
      </div>

      <div style={{ width: '100%', maxWidth: 920, padding: '0 24px 48px', boxSizing: 'border-box' }}>

        {/* ══ SALES — straight from Salesforce ══ */}
        {stats && (
          <>
            <SectionHead title="Sales" sub="From Salesforce" />
            <SyncStrip status={syncStatus} />

            {/* Organizations won + what they're worth */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 16 }}>
              <div style={{ background: olive, borderRadius: 18, padding: '22px 24px', boxShadow: '0 10px 28px rgba(26,37,64,0.28)' }}>
                <div style={{ color: '#fff', fontWeight: 800, fontSize: 34, lineHeight: 1 }}>
                  <RollUp value={stats.won_org_count ?? 0} format={(n) => Math.round(n).toLocaleString()} />
                </div>
                <div style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>Organizations won</div>
                <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12.5, marginTop: 4 }}>{stats.won_count_total} {stats.won_count_total === 1 ? 'contract' : 'contracts'} signed</div>
              </div>
              <div style={{ background: navy, borderRadius: 18, padding: '22px 24px', boxShadow: '0 10px 28px rgba(26,37,64,0.28)' }}>
                <div style={{ color: '#fff', fontWeight: 800, fontSize: 34, lineHeight: 1 }}>
                  <RollUp value={stats.won_revenue_total} format={money} />
                </div>
                <div style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>Contract value</div>
                <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12.5, marginTop: 4 }}>NPSA revenue won</div>
              </div>
              {apps && (
                <div style={{ background: navy, borderRadius: 18, padding: '22px 24px', boxShadow: '0 10px 28px rgba(26,37,64,0.28)' }}>
                  <div style={{ color: '#fff', fontWeight: 800, fontSize: 34, lineHeight: 1 }}>
                    <RollUp value={apps.total} format={(n) => Math.round(n).toLocaleString()} />
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11.5, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>Grant applications</div>
                  <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12.5, marginTop: 4 }}>{apps.preparing_count} preparing · {apps.pending_count} submitted</div>
                </div>
              )}
            </div>

            {/* Grant dollars: brought in vs still in play */}
            {apps && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, marginBottom: 16 }}>
                <div style={{ ...card, padding: '20px 22px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#7a869f', textTransform: 'uppercase', letterSpacing: 0.5 }}>Awarded to clients</div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: '#7a8c1e', marginTop: 6 }}>{money(apps.awarded_amount)}</div>
                  <div style={{ fontSize: 12.5, color: '#7a869f', marginTop: 4 }}>{apps.awarded_count} accepted {apps.awarded_count === 1 ? 'application' : 'applications'}</div>
                </div>
                <div style={{ ...card, padding: '20px 22px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#7a869f', textTransform: 'uppercase', letterSpacing: 0.5 }}>Pending award</div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: '#1a2540', marginTop: 6 }}>{money(apps.pending_amount)}</div>
                  <div style={{ fontSize: 12.5, color: '#7a869f', marginTop: 4 }}>{apps.pending_count} submitted, awaiting notification</div>
                </div>
                <div style={{ ...card, padding: '20px 22px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#7a869f', textTransform: 'uppercase', letterSpacing: 0.5 }}>Acceptance rate</div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: '#1a2540', marginTop: 6 }}>{pct(apps.acceptance_rate)}</div>
                  <div style={{ fontSize: 12.5, color: '#7a869f', marginTop: 4 }}>
                    {apps.awarded_count} of {apps.awarded_count + apps.denied_count} decided
                    {apps.award_fill_rate > 0 ? ` · ${pct(apps.award_fill_rate)} of ask funded` : ''}
                  </div>
                </div>
              </div>
            )}

            {/* By grant program (collapsible) */}
            {apps && apps.by_program?.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <button onClick={() => setShowPrograms(v => !v)}
                  style={{ background: 'none', border: 'none', padding: 0, color: '#1a4a6e', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', marginBottom: showPrograms ? 10 : 0 }}>
                  {showPrograms ? 'Hide' : 'Show'} breakdown by grant program {showPrograms ? '▾' : '▸'}
                </button>
                {showPrograms && (
                  <div style={{ ...card, padding: '8px 6px' }}>
                    <div style={{ display: 'flex', fontSize: 11, fontWeight: 700, color: '#9aa3b8', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 16px' }}>
                      <div style={{ flex: 2 }}>Program</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>Apps</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>Awarded</div>
                      <div style={{ flex: 1, textAlign: 'right' }}>Pending</div>
                    </div>
                    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                      {apps.by_program.map((p) => (
                        <div key={p.grant_program} style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid #f0f2f6', fontSize: 13.5 }}>
                          <div style={{ flex: 2, color: '#1a2540', fontWeight: 600 }}>{p.grant_program}</div>
                          <div style={{ flex: 1, textAlign: 'right', color: '#5b6b8c' }}>{p.total}</div>
                          <div style={{ flex: 1, textAlign: 'right', fontWeight: 700, color: p.awarded_amount ? '#7a8c1e' : '#c2cad6' }}>{p.awarded_amount ? money(p.awarded_amount) : '—'}</div>
                          <div style={{ flex: 1, textAlign: 'right', color: '#5b6b8c' }}>{p.pending_amount ? money(p.pending_amount) : '—'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sales trend — momentum, not just all-time totals */}
            {salesSeries.length > 0 && (
              <div style={{ ...card, padding: '18px 22px', marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#1a2540', fontSize: 15 }}>
                      {salesCfg.title} over time{salesCumulative ? ' (cumulative)' : ''}
                    </div>
                    <div style={{ fontSize: 12.5, color: '#7a869f', marginTop: 3 }}>
                      {salesCumulative ? 'Running total · now at ' : 'Total shown · '}
                      <strong style={{ color: '#7a8c1e' }}>{fmtSalesVal(salesTotal)}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['month', 'quarter'].map(g => (
                      <button key={g} onClick={() => setSalesGran(g)}
                        style={{ border: '1px solid #d0d6e0', background: salesGran === g ? '#1a4a6e' : '#fff', color: salesGran === g ? '#fff' : '#5b6b8c', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' }}>{g}</button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                  {SALES_METRICS.map(m => (
                    <button key={m.key} onClick={() => setSalesMetric(m.key)}
                      style={{ border: '1px solid #d0d6e0', background: salesMetric === m.key ? '#eef4f8' : '#fff', color: salesMetric === m.key ? '#1a4a6e' : '#7a869f', fontWeight: salesMetric === m.key ? 700 : 500, borderRadius: 8, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>{m.label}</button>
                  ))}
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 5, height: 130 }}>
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, borderTop: '1px dashed #f0f2f6' }} />
                  <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed #f0f2f6' }} />
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: '1px solid #e6e9f0' }} />
                  {salesShown.map(s => (
                    <div key={s.period} title={`${fmtSalesPeriod(s.period)} — ${salesCfg.title}: ${fmtSalesVal(s.v)}`}
                      style={{ flex: 1, height: '100%', position: 'relative', zIndex: 1 }}>
                      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '72%', height: `${(s.v / salesMax) * 100}%`, background: olive, borderRadius: '4px 4px 0 0', minHeight: s.v > 0 ? 2 : 0 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                  {salesShown.map((s, i) => (
                    <div key={s.period} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#9aa3b8', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      {salesLabelIdx.has(i) ? fmtSalesPeriod(s.period) : ''}
                    </div>
                  ))}
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6b8c', cursor: 'pointer', userSelect: 'none', marginTop: 12 }}>
                  <input type="checkbox" checked={salesCumulative} onChange={e => setSalesCumulative(e.target.checked)} style={{ cursor: 'pointer' }} />
                  Show cumulative growth
                </label>
              </div>
            )}

            {/* ══ MARKETING — what feeds the sales above ══ */}
            <SectionHead title="Marketing" sub="What feeds the pipeline · tracked since Feb 2026" />

            {/* The bridge: how much of won revenue traces back to a tracked booking */}
            <div style={{ ...card, padding: '16px 20px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <span style={{ fontWeight: 700, color: '#1a2540', fontSize: 14 }}>Marketing-attributed revenue</span>
                <span style={{ fontSize: 12.5, color: '#7a869f' }}>
                  <strong style={{ color: '#7a8c1e' }}>{money(stats.attributed_revenue)}</strong> of {money(stats.won_revenue_total)} traces to a tracked booking
                </span>
              </div>
              <div style={{ height: 10, borderRadius: 6, background: '#eef1f6', overflow: 'hidden' }}>
                <div style={{ width: `${Math.round((stats.attribution_coverage || 0) * 100)}%`, height: '100%', background: olive, borderRadius: 6, transition: 'width .6s ease' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#9aa3b8', flexWrap: 'wrap', gap: 8 }}>
                <span>{pct(stats.attribution_coverage)} attributed · {stats.attributed_count} {stats.attributed_count === 1 ? 'win' : 'wins'}</span>
                {stats.untracked_count > 0 ? (
                  <button onClick={() => setShowUntracked(v => !v)} style={{ background: 'none', border: 'none', padding: 0, color: '#1a4a6e', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    {money(stats.untracked_revenue)} untracked / pre-funnel · {stats.untracked_count} {stats.untracked_count === 1 ? 'deal' : 'deals'} · {showUntracked ? 'hide' : 'show'} {showUntracked ? '▾' : '▸'}
                  </button>
                ) : <span>no untracked wins</span>}
              </div>
            </div>

            {/* collapsible untracked list */}
            {showUntracked && (
              <div style={{ ...card, padding: '8px 6px', marginBottom: 16 }}>
                <div style={{ display: 'flex', fontSize: 11, fontWeight: 700, color: '#9aa3b8', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 16px' }}>
                  <div style={{ flex: 1 }}>Organization</div>
                  <div style={{ width: 110, textAlign: 'right' }}>Closed</div>
                  <div style={{ width: 110, textAlign: 'right' }}>Amount</div>
                </div>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {untracked.length === 0 && <div style={{ padding: '12px 16px', color: '#9aa3b8', fontSize: 13 }}>No untracked wins.</div>}
                  {untracked.map((u) => (
                    <div key={u.opportunity_id} style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid #f0f2f6', fontSize: 13.5 }}>
                      <div style={{ flex: 1, color: '#1a2540', fontWeight: 600 }}>{u.organization || '—'}</div>
                      <div style={{ width: 110, textAlign: 'right', color: '#7a869f' }}>{u.close_date ? new Date(u.close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</div>
                      <div style={{ width: 110, textAlign: 'right', fontWeight: 700, color: '#1a2540' }}>{money(u.amount)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Booking KPIs — grid so an odd count wraps evenly instead of one tile
                stretching across a whole row. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 24 }}>
              <StatCard bg={olive} value={stats.bookings_this_week} format={(n) => Math.round(n).toLocaleString()} sub="Bookings this week" />
              <StatCard bg={navy} value={stats.bookings_this_month} format={(n) => Math.round(n).toLocaleString()} sub={`Bookings this month (${mom >= 0 ? '+' : ''}${mom} vs last)`} />
              <StatCard bg={olive} value={stats.client_rate} format={pct} sub="LOE sent" />
              <StatCard bg={navy} value={stats.instantly_pct} format={pct} sub="From Instantly" />
              <StatCard bg={olive} value={stats.total_fees_won} format={money} sub="LOE value" />
            </div>
          </>
        )}

        {/* Funnel */}
        {funnel && (<>
          <div style={label}>Booking Funnel</div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            {[
              { k: 'Booked', v: funnel.booked, base: funnel.booked },
              { k: 'Held', v: funnel.held, base: funnel.booked },
              { k: 'LOE Sent', v: funnel.clients, base: funnel.booked, foot: money(funnel.fees) + ' in LOE value' },
              { k: 'Won', v: funnel.won, base: funnel.booked, foot: money(funnel.won_amount) + ' in revenue' },
            ].map((s, i) => (
              <div key={s.k} style={{ ...card, flex: 1, padding: '20px 22px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#7a869f', textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.k}</div>
                <div style={{ fontSize: 34, fontWeight: 800, color: '#1a2540', marginTop: 6 }}>{s.v}</div>
                <div style={{ fontSize: 12.5, color: '#7a869f', marginTop: 4 }}>{i === 0 ? ' ' : pct(s.base ? s.v / s.base : 0) + ' of booked'}</div>
                {s.foot && <div style={{ fontSize: 13, fontWeight: 700, color: '#7a8c1e', marginTop: 6 }}>{s.foot}</div>}
              </div>
            ))}
          </div>
        </>)}

        {/* Time series + channel side by side */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <div style={{ ...card, flex: 2, padding: '18px 22px', minWidth: 320 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontWeight: 700, color: '#1a2540', fontSize: 15 }}>{metricCfg.title} over time</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {['week', 'month'].map(g => (
                  <button key={g} onClick={() => { setGran(g); setWinOffset(0); }} style={{ border: '1px solid #d0d6e0', background: gran === g ? '#1a4a6e' : '#fff', color: gran === g ? '#fff' : '#5b6b8c', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' }}>{g}</button>
                ))}
              </div>
            </div>
            {/* metric toggle */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              {METRICS.map(m => (
                <button key={m.key} onClick={() => setMetric(m.key)}
                  style={{ border: '1px solid #d0d6e0', background: metric === m.key ? '#eef4f8' : '#fff', color: metric === m.key ? '#1a4a6e' : '#7a869f', fontWeight: metric === m.key ? 700 : 500, borderRadius: 8, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>{m.label}</button>
              ))}
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: barGap, height: 120 }}>
              {/* faint gridlines + baseline */}
              <div style={{ position: 'absolute', left: 0, right: 0, top: 0, borderTop: '1px dashed #f0f2f6' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px dashed #f0f2f6' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: '1px solid #e6e9f0' }} />
              {shown.length === 0 && <div style={{ color: '#9aa3b8', fontSize: 13, position: 'relative' }}>No data yet.</div>}
              {shown.map((s, i) => {
                const cur = metricVal(s);
                const ghost = ghostOf(i);
                const prev = series[start + i - 1];
                const delta = compare && prev ? cur - metricVal(prev) : null;
                const title = `${fmtPeriod(s.period, gran)} — ${metricCfg.title}: ${fmtMetric(cur)}`
                  + (delta !== null ? ` (${delta >= 0 ? '+' : ''}${fmtMetric(delta)} vs prev)` : '');
                return (
                  <div key={s.period} title={title} style={{ flex: 1, height: '100%', position: 'relative', zIndex: 1 }}>
                    {compare && ghost > 0 && (
                      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: ghostW, height: `${(ghost / maxSeries) * 100}%`, background: '#c9d2e0', borderRadius: '4px 4px 0 0', opacity: 0.6 }} />
                    )}
                    <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: barW, height: `${(cur / maxSeries) * 100}%`, background: navy, borderRadius: '4px 4px 0 0', minHeight: cur > 0 ? 2 : 0 }} />
                  </div>
                );
              })}
            </div>
            {/* x-axis labels — evenly spaced, first & last always shown */}
            {shown.length > 0 && (
              <div style={{ display: 'flex', gap: barGap, marginTop: 6 }}>
                {shown.map((s, i) => (
                  <div key={s.period} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#9aa3b8', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {labelIdx.has(i) ? fmtPeriod(s.period, gran) : ''}
                  </div>
                ))}
              </div>
            )}
            {/* stepper + compare toggle */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => canOlder && setWinOffset(o => Math.min(maxOffset, o + step))} disabled={!canOlder}
                  style={{ border: '1px solid #d0d6e0', background: '#fff', color: canOlder ? '#1a4a6e' : '#c2cad6', borderRadius: 8, padding: '2px 9px', fontSize: 14, cursor: canOlder ? 'pointer' : 'default', lineHeight: 1.4 }}>&#8249;</button>
                <span style={{ fontSize: 11.5, color: '#7a869f', minWidth: 88, textAlign: 'center' }}>{rangeLabel}</span>
                <button onClick={() => canNewer && setWinOffset(o => Math.max(0, o - step))} disabled={!canNewer}
                  style={{ border: '1px solid #d0d6e0', background: '#fff', color: canNewer ? '#1a4a6e' : '#c2cad6', borderRadius: 8, padding: '2px 9px', fontSize: 14, cursor: canNewer ? 'pointer' : 'default', lineHeight: 1.4 }}>&#8250;</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6b8c', cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} style={{ cursor: 'pointer' }} />
                Compare previous period
              </label>
            </div>
          </div>
          <div style={{ ...card, flex: 1, padding: '18px 22px', minWidth: 240 }}>
            <div style={{ fontWeight: 700, color: '#1a2540', fontSize: 15, marginBottom: 12 }}>By channel</div>
            {byChannel.length === 0 && <div style={{ color: '#9aa3b8', fontSize: 13 }}>No data yet.</div>}
            {byChannel.map(c => (
              <div key={c.channel} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f4f5f9', fontSize: 14 }}>
                <span style={{ color: '#1a2540', textTransform: 'capitalize' }}>{c.channel}</span>
                <span style={{ color: '#5b6b8c' }}>{c.booked}{c.clients ? ` · ${c.clients} LOE` : ''}</span>
              </div>
            ))}
          </div>
        </div>

        {/* By campaign — the leadership view */}
        <div style={label}>By Campaign &amp; Source</div>
        <div style={{ ...card, padding: '8px 0', marginBottom: 24 }}>
          <div style={{ display: 'flex', padding: '10px 22px', fontSize: 11.5, fontWeight: 700, color: '#9aa3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <div style={{ flex: 2 }}>Campaign</div><div style={{ flex: 1, textAlign: 'right' }}>Booked</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Held</div><div style={{ flex: 1, textAlign: 'right' }}>LOEs</div><div style={{ flex: 1, textAlign: 'right' }}>LOE $</div>
          </div>
          {byCampaign.length === 0 && <div style={{ padding: '14px 22px', color: '#9aa3b8' }}>No data yet.</div>}
          {byCampaign.map((c, i) => (
            <div key={c.campaign} style={{ display: 'flex', alignItems: 'center', padding: '13px 22px', borderTop: '1px solid #f4f5f9' }}>
              <div style={{ flex: 2 }}>
                <div style={{ fontWeight: 600, color: '#1a2540', fontSize: 14.5 }}>{c.campaign}</div>
                <div style={{ height: 5, borderRadius: 4, marginTop: 6, background: '#eef0f5', overflow: 'hidden', maxWidth: 220 }}>
                  <div style={{ width: `${(c.booked / maxCamp) * 100}%`, height: '100%', background: olive }} />
                </div>
              </div>
              <div style={{ flex: 1, textAlign: 'right', fontWeight: 700, color: '#1a2540' }}>{c.booked}</div>
              <div style={{ flex: 1, textAlign: 'right', color: '#5b6b8c' }}>{c.held}</div>
              <div style={{ flex: 1, textAlign: 'right', color: '#5b6b8c' }}>{c.clients}</div>
              <div style={{ flex: 1, textAlign: 'right', fontWeight: 700, color: '#7a8c1e' }}>{c.fees ? money(c.fees) : '—'}</div>
            </div>
          ))}
        </div>

        {/* Bookings table */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ ...label, margin: 0 }}>Bookings</div>
          <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadRows()} placeholder="Search name / org / email"
            style={{ border: '1px solid #d0d6e0', borderRadius: 8, padding: '7px 12px', fontSize: 13, width: 240 }} />
        </div>
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', padding: '11px 18px', fontSize: 11, fontWeight: 700, color: '#9aa3b8', textTransform: 'uppercase', letterSpacing: 0.5, background: '#fafbfc' }}>
            <div style={{ flex: 2 }}>Org / Name</div><div style={{ flex: 1.4 }}>Channel</div><div style={{ flex: 1.6 }}>Campaign</div>
            <div style={{ flex: 1 }}>Meeting</div><div style={{ width: 70, textAlign: 'center' }}>Held</div><div style={{ width: 70, textAlign: 'center' }}>LOE</div>
          </div>
          {rows.length === 0 && <div style={{ padding: '16px 18px', color: '#9aa3b8' }}>No bookings yet.</div>}
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {rows.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', padding: '11px 18px', borderTop: '1px solid #f4f5f9', fontSize: 13.5 }}>
                <div style={{ flex: 2 }}>
                  <div style={{ fontWeight: 600, color: '#1a2540' }}>{r.organization || '—'}</div>
                  <div style={{ color: '#9aa3b8', fontSize: 12 }}>{r.name}</div>
                </div>
                <div style={{ flex: 1.4, color: '#5b6b8c' }}>{chLabel(r.attribution_channel || 'direct')}</div>
                <div style={{ flex: 1.6, color: '#5b6b8c' }}>{r.instantly_campaign || '—'}</div>
                <div style={{ flex: 1, color: '#5b6b8c' }}>{r.meeting_date ? new Date(r.meeting_date).toLocaleDateString() : '—'}</div>
                <div style={{ width: 70, textAlign: 'center' }}>
                  <input type="checkbox" checked={!!r.held} onChange={e => toggle(r.id, 'held', e.target.checked)} />
                </div>
                <div style={{ width: 70, textAlign: 'center' }}>
                  <input type="checkbox" checked={!!r.became_client} onChange={e => toggle(r.id, 'became_client', e.target.checked)} />
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
