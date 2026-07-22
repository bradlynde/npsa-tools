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

function StatCard({ bg, value, format, sub, playToken }) {
  const [roll, setRoll] = useState(playToken || 0);
  return (
    <div onMouseEnter={() => setRoll(k => k + 1)}
      style={{ flex: 1, background: bg, borderRadius: 18, padding: '22px 24px', boxShadow: '0 10px 28px rgba(26,37,64,0.28)', cursor: 'default', minWidth: 150 }}>
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 34, lineHeight: 1 }}>
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

  const loadRows = () => j(`/api/marketing/bookings?search=${encodeURIComponent(search)}`).then(d => d && setRows(d));
  useEffect(() => {
    j('/api/marketing/stats').then(setStats);
    j('/api/marketing/funnel').then(setFunnel);
    j('/api/marketing/by-campaign').then(d => d && setByCampaign(d));
    j('/api/marketing/by-channel').then(d => d && setByChannel(d));
    loadRows();
  }, []);
  useEffect(() => { j(`/api/marketing/timeseries?granularity=${gran}`).then(d => d && setSeries(d)); }, [gran]);

  const toggle = async (id, field, val) => {
    await fetch(`/api/marketing/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: val }) });
    loadRows(); j('/api/marketing/stats').then(setStats); j('/api/marketing/funnel').then(setFunnel);
  };

  const mom = stats ? stats.bookings_this_month - stats.bookings_last_month : 0;
  const maxSeries = Math.max(1, ...series.map(s => s.booked));
  const maxCamp = Math.max(1, ...byCampaign.map(c => c.booked));

  return (
    <div style={{ minHeight: '100vh', background: '#d8dfe8', fontFamily: 'Inter,sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 920, padding: '20px 24px 0', boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {onBack ? <button onClick={onBack} style={{ background: '#fff', border: '1px solid #d0d6e0', borderRadius: 10, padding: '8px 14px', color: '#5b6b8c', cursor: 'pointer', fontWeight: 600 }}>&#8592; Back</button> : <span />}
        <button onClick={() => fetch('/api/marketing/enrich', { method: 'POST' }).then(() => window.location.reload())}
          style={{ background: '#fff', border: '1px solid #d0d6e0', borderRadius: 10, padding: '8px 14px', color: '#5b6b8c', cursor: 'pointer', fontWeight: 600 }}>Refresh data</button>
      </div>

      <div style={{ textAlign: 'center', padding: '18px 32px 16px' }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: '#1a2540', letterSpacing: -0.5 }}>Marketing Dashboard</div>
        <div style={{ fontSize: 15, color: '#5b6b8c', marginTop: 6 }}>Where bookings come from, and what they turn into.</div>
      </div>

      <div style={{ width: '100%', maxWidth: 920, padding: '0 24px 48px', boxSizing: 'border-box' }}>

        {/* KPI cards */}
        {stats && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard bg={navy} value={stats.bookings_this_month} format={(n) => Math.round(n).toLocaleString()} sub={`Bookings this month (${mom >= 0 ? '+' : ''}${mom} vs last)`} />
            <StatCard bg={olive} value={stats.held_rate} format={pct} sub="Held rate" />
            <StatCard bg={navy} value={stats.client_rate} format={pct} sub="Became client" />
            <StatCard bg={olive} value={stats.instantly_pct} format={pct} sub="From Instantly" />
            <StatCard bg={navy} value={stats.total_fees_won} format={money} sub="Fees won" />
          </div>
        )}

        {/* Funnel */}
        {funnel && (<>
          <div style={label}>Funnel</div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            {[
              { k: 'Booked', v: funnel.booked, base: funnel.booked },
              { k: 'Held', v: funnel.held, base: funnel.booked },
              { k: 'Became Client', v: funnel.clients, base: funnel.booked, foot: money(funnel.fees) + ' in fees' },
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

        {/* By campaign — the leadership view */}
        <div style={label}>By Instantly Campaign</div>
        <div style={{ ...card, padding: '8px 0', marginBottom: 24 }}>
          <div style={{ display: 'flex', padding: '10px 22px', fontSize: 11.5, fontWeight: 700, color: '#9aa3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <div style={{ flex: 2 }}>Campaign</div><div style={{ flex: 1, textAlign: 'right' }}>Booked</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Held</div><div style={{ flex: 1, textAlign: 'right' }}>Clients</div><div style={{ flex: 1, textAlign: 'right' }}>Fees</div>
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

        {/* Time series + channel side by side */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <div style={{ ...card, flex: 2, padding: '18px 22px', minWidth: 320 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, color: '#1a2540', fontSize: 15 }}>Bookings over time</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {['week', 'month'].map(g => (
                  <button key={g} onClick={() => setGran(g)} style={{ border: '1px solid #d0d6e0', background: gran === g ? '#1a4a6e' : '#fff', color: gran === g ? '#fff' : '#5b6b8c', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' }}>{g}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
              {series.length === 0 && <div style={{ color: '#9aa3b8', fontSize: 13 }}>No data yet.</div>}
              {series.map(s => (
                <div key={s.period} title={`${s.period}: ${s.booked} booked, ${s.clients} clients`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <div style={{ width: '70%', height: `${(s.booked / maxSeries) * 100}%`, background: navy, borderRadius: '4px 4px 0 0', minHeight: 2 }} />
                </div>
              ))}
            </div>
          </div>
          <div style={{ ...card, flex: 1, padding: '18px 22px', minWidth: 240 }}>
            <div style={{ fontWeight: 700, color: '#1a2540', fontSize: 15, marginBottom: 12 }}>By channel</div>
            {byChannel.length === 0 && <div style={{ color: '#9aa3b8', fontSize: 13 }}>No data yet.</div>}
            {byChannel.map(c => (
              <div key={c.channel} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f4f5f9', fontSize: 14 }}>
                <span style={{ color: '#1a2540', textTransform: 'capitalize' }}>{c.channel}</span>
                <span style={{ color: '#5b6b8c' }}>{c.booked}{c.clients ? ` · ${c.clients} won` : ''}</span>
              </div>
            ))}
          </div>
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
            <div style={{ flex: 1 }}>Meeting</div><div style={{ width: 70, textAlign: 'center' }}>Held</div><div style={{ width: 70, textAlign: 'center' }}>Won</div>
          </div>
          {rows.length === 0 && <div style={{ padding: '16px 18px', color: '#9aa3b8' }}>No bookings yet.</div>}
          {rows.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', padding: '11px 18px', borderTop: '1px solid #f4f5f9', fontSize: 13.5 }}>
              <div style={{ flex: 2 }}>
                <div style={{ fontWeight: 600, color: '#1a2540' }}>{r.organization || '—'}</div>
                <div style={{ color: '#9aa3b8', fontSize: 12 }}>{r.name}</div>
              </div>
              <div style={{ flex: 1.4, color: '#5b6b8c', textTransform: 'capitalize' }}>{r.attribution_channel || 'organic'}</div>
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
  );
}
