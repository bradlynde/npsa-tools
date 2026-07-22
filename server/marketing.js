// server/marketing.js
// NPSA Marketing Dashboard — backend module.
// Drop this file into /server and register it from server/index.js:
//
//     import { registerMarketing } from './marketing.js';
//     // ...after `pool` is created and after app.use(express.json())...
//     registerMarketing(app, pool);        // place BEFORE the app.get('*') SPA fallback
//
// Everything lives here so the change to index.js is two lines.
// The dashboard works fully from UTM tags alone; the Instantly/Calendly
// lookups are best-effort and fail safe (a bad key or endpoint never breaks
// ingestion or the dashboard — the row just stays unenriched).

// ─────────────────────────────────────────────────────────────
// 1. Campaign slug ⇄ name map (edit when campaigns are added)
// ─────────────────────────────────────────────────────────────
const CAMPAIGN_SLUGS = {
  'broader-church-p1': 'Broader Church Campaign – Phase 1',
  'broader-church-p2': 'Broader Church Campaign – Phase 2',
  'broader-church-p3': 'Broader Church Campaign – Phase 3',
  'il-outreach-uncontacted': 'IL Outreach – Uncontacted',
  'il-outreach-contacted': 'IL Outreach – Contacted',
  'tx-nsgp-church': 'TX NSGP – Church',
  'tx-fy26-deadline': 'TX Campaign – FY2026 Deadline Push',
  'christian-schools': 'Christian Schools Campaign',
  'facility-security': 'Facility and Security Campaign',
  'ca-csnsgp-fy26': 'CA Outreach – CSNSGP FY26',
  'xp-campaign': 'XP Campaign',
  'iowa-schools': 'Iowa Schools',
};
const slugToName = (slug) => CAMPAIGN_SLUGS[(slug || '').trim().toLowerCase()] || (slug || null);

// ─────────────────────────────────────────────────────────────
// 2. Schema (same CREATE IF NOT EXISTS pattern as letters/reps)
// ─────────────────────────────────────────────────────────────
async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id                  SERIAL PRIMARY KEY,
      calendly_uri        TEXT UNIQUE,
      event_uri           TEXT,
      booked_on           TIMESTAMPTZ,
      meeting_date        TIMESTAMPTZ,
      name                TEXT,
      email               TEXT,
      organization        TEXT,
      told_us             TEXT,
      referred_by         TEXT,
      utm_source          TEXT,
      utm_medium          TEXT,
      utm_campaign        TEXT,
      has_gclid           BOOLEAN DEFAULT FALSE,
      host                TEXT,
      instantly_campaign  TEXT,
      attribution_channel TEXT,
      attribution_source  TEXT,
      held                BOOLEAN,
      held_source         TEXT,
      became_client       BOOLEAN DEFAULT FALSE,
      client_letter_id    INTEGER,
      fee                 NUMERIC DEFAULT 0,
      manual_override     JSONB DEFAULT '{}',
      enriched_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('bookings schema error:', err.message));
}

// ─────────────────────────────────────────────────────────────
// 3. Instantly reverse-match helpers (best-effort, fail safe)
//    NOTE for dev: verify these v2 paths/field names against the
//    Instantly API docs; if they differ, only the reverse-match is
//    affected — UTM attribution keeps working regardless.
// ─────────────────────────────────────────────────────────────
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
let _campaignCache = { at: 0, map: {} };

async function instantlyCampaignMap() {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return {};
  if (Date.now() - _campaignCache.at < 60 * 60 * 1000) return _campaignCache.map; // 1h cache
  try {
    const r = await fetch(`${INSTANTLY_BASE}/campaigns?limit=100`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return _campaignCache.map;
    const data = await r.json();
    const map = {};
    for (const c of (data.items || data || [])) map[c.id] = c.name;
    _campaignCache = { at: Date.now(), map };
    return map;
  } catch { return _campaignCache.map; }
}

async function instantlyFindLead(email) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key || !email) return null;
  try {
    const r = await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: email, limit: 1 }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data.items || [])[0] || null;
  } catch { return null; }
}

async function instantlyFindLeadByNameOrg(lastName, org) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key || !lastName) return null;
  try {
    const r = await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: lastName, limit: 20 }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(org);
    if (!target) return null;
    return (data.items || []).find(l => {
      const c = norm(l.company_name);
      return c && (c.includes(target) || target.includes(c));
    }) || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// 4. Calendly held-status (best-effort, fail safe)
// ─────────────────────────────────────────────────────────────
async function calendlyHeld(eventUri) {
  const key = process.env.CALENDLY_API_TOKEN;
  if (!key || !eventUri) return { held: null, source: null };
  try {
    const ev = await fetch(eventUri, { headers: { Authorization: `Bearer ${key}` } });
    if (ev.ok) {
      const evData = await ev.json();
      if (evData.resource?.status === 'canceled') return { held: false, source: 'calendly' };
    }
    const inv = await fetch(`${eventUri}/invitees`, { headers: { Authorization: `Bearer ${key}` } });
    if (inv.ok) {
      const invData = await inv.json();
      const first = (invData.collection || [])[0];
      if (first?.no_show) return { held: false, source: 'calendly' };
      if (first) return { held: true, source: 'calendly' };
    }
  } catch { /* fall through */ }
  return { held: null, source: null };
}

// ─────────────────────────────────────────────────────────────
// 5. Channel derivation
// ─────────────────────────────────────────────────────────────
function deriveChannel(row, instantlyCampaign) {
  if (instantlyCampaign) return 'instantly';
  const t = (row.told_us || '').toLowerCase();
  if (t.includes('email from nonprofit') || t.includes('email from npsa')) return 'instantly';
  if (t.includes('google')) return 'google';
  if (t.includes('refer')) return 'referral';
  if (t.includes('conference') || t.includes('event')) return 'conference';
  if (t.includes('linkedin')) return 'linkedin';
  if (row.has_gclid) return 'google';
  return 'organic';
}

// ─────────────────────────────────────────────────────────────
// 6. Enrichment (Instantly campaign + held + became-client/fee)
// ─────────────────────────────────────────────────────────────
async function enrichBooking(pool, id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
  const row = rows[0];
  if (!row) return;
  const override = row.manual_override || {};

  // --- Instantly campaign ---
  let campaign = null, source = 'none';
  if ((row.utm_source || '').toLowerCase() === 'instantly' && row.utm_campaign) {
    campaign = slugToName(row.utm_campaign); source = 'utm';
  } else {
    const lead = await instantlyFindLead(row.email);
    if (lead?.campaign) {
      const map = await instantlyCampaignMap();
      campaign = map[lead.campaign] || null; source = 'reverse_email';
    }
    if (!campaign) {
      const last = (row.name || '').trim().split(/\s+/).pop();
      const lead2 = await instantlyFindLeadByNameOrg(last, row.organization);
      if (lead2?.campaign) {
        const map = await instantlyCampaignMap();
        campaign = map[lead2.campaign] || null; source = 'reverse_name_org';
      }
    }
  }
  const channel = deriveChannel(row, campaign);

  // --- Held ---
  let held = row.held, heldSource = row.held_source;
  if (typeof override.held === 'boolean') { held = override.held; heldSource = 'manual'; }
  else if (row.meeting_date && new Date(row.meeting_date) < new Date()) {
    const h = await calendlyHeld(row.event_uri);
    if (h.held !== null) { held = h.held; heldSource = h.source; }
  }

  // --- Became client + fee (join to letters, same DB) ---
  let becameClient = false, letterId = null, fee = 0;
  if (row.organization) {
    const m = await pool.query(
      `SELECT id, total_fee FROM letters
       WHERE doc_tab NOT IN ('proposal','addendum')
         AND client_name ILIKE '%' || $1 || '%'
       ORDER BY created_at DESC LIMIT 1`,
      [row.organization]
    );
    if (m.rows[0]) { becameClient = true; letterId = m.rows[0].id; fee = Number(m.rows[0].total_fee) || 0; }
  }
  if (typeof override.became_client === 'boolean') becameClient = override.became_client;

  await pool.query(
    `UPDATE bookings SET
       instantly_campaign=$1, attribution_channel=$2, attribution_source=$3,
       held=$4, held_source=$5, became_client=$6, client_letter_id=$7, fee=$8,
       enriched_at=NOW(), updated_at=NOW()
     WHERE id=$9`,
    [campaign, channel, source, held, heldSource, becameClient, letterId, fee, id]
  );
}

// ─────────────────────────────────────────────────────────────
// 7. Upsert (ingest)
// ─────────────────────────────────────────────────────────────
async function upsertBooking(pool, b) {
  let existing = null;
  if (b.calendly_uri) {
    const r = await pool.query('SELECT id FROM bookings WHERE calendly_uri=$1', [b.calendly_uri]);
    existing = r.rows[0];
  }
  if (!existing && b.email && b.meeting_date) {
    const r = await pool.query('SELECT id FROM bookings WHERE email=$1 AND meeting_date=$2', [b.email, b.meeting_date]);
    existing = r.rows[0];
  }
  const cols = ['calendly_uri','event_uri','booked_on','meeting_date','name','email','organization',
    'told_us','referred_by','utm_source','utm_medium','utm_campaign','has_gclid','host'];
  const vals = cols.map(c => b[c] ?? null);
  if (existing) {
    const set = cols.map((c, i) => `${c}=COALESCE($${i + 1}, ${c})`).join(', ');
    await pool.query(`UPDATE bookings SET ${set}, updated_at=NOW() WHERE id=$${cols.length + 1}`, [...vals, existing.id]);
    return existing.id;
  }
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(`INSERT INTO bookings (${cols.join(', ')}) VALUES (${ph}) RETURNING id`, vals);
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────
// 8. Routes
// ─────────────────────────────────────────────────────────────
export function registerMarketing(app, pool) {
  if (!pool) { console.warn('[marketing] no DB pool — marketing endpoints disabled'); return; }
  ensureSchema(pool);
  const guard = (res) => res.status(503).json({ error: 'Storage not configured' });

  // Ingest (called by Zapier). Protect with a shared secret.
  app.post('/api/marketing/bookings/ingest', async (req, res) => {
    if (!pool) return guard(res);
    if (process.env.ZAPIER_WEBHOOK_SECRET && req.headers['x-zap-secret'] !== process.env.ZAPIER_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const id = await upsertBooking(pool, req.body || {});
      enrichBooking(pool, id).catch(e => console.error('enrich error:', e.message)); // async, don't block
      res.json({ ok: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Re-run enrichment for stale rows (or ?all=1 for everything).
  app.post('/api/marketing/enrich', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const all = req.query.all === '1';
      const { rows } = await pool.query(
        all ? 'SELECT id FROM bookings'
            : `SELECT id FROM bookings WHERE enriched_at IS NULL OR (meeting_date < NOW() AND held IS NULL)`
      );
      for (const r of rows) { try { await enrichBooking(pool, r.id); } catch (e) { console.error(e.message); } }
      res.json({ ok: true, enriched: rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // KPI cards
  app.get('/api/marketing/stats', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*)::int AS total_bookings,
          COUNT(*) FILTER (WHERE date_trunc('month', booked_on) = date_trunc('month', NOW()))::int AS bookings_this_month,
          COUNT(*) FILTER (WHERE date_trunc('month', booked_on) = date_trunc('month', NOW() - interval '1 month'))::int AS bookings_last_month,
          COUNT(*) FILTER (WHERE became_client)::int AS clients,
          COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS total_fees_won,
          COUNT(*) FILTER (WHERE attribution_channel='instantly')::int AS instantly_count,
          COUNT(*) FILTER (WHERE held IS NOT NULL)::int AS resolved_meetings,
          COUNT(*) FILTER (WHERE held IS TRUE)::int AS held_count
        FROM bookings`);
      const s = rows[0];
      res.json({
        total_bookings: s.total_bookings,
        bookings_this_month: s.bookings_this_month,
        bookings_last_month: s.bookings_last_month,
        client_rate: s.total_bookings ? s.clients / s.total_bookings : 0,
        held_rate: s.resolved_meetings ? s.held_count / s.resolved_meetings : 0,
        instantly_pct: s.total_bookings ? s.instantly_count / s.total_bookings : 0,
        total_fees_won: Number(s.total_fees_won),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Funnel
  app.get('/api/marketing/funnel', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
        FROM bookings`);
      res.json({ ...rows[0], fees: Number(rows[0].fees) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // By Instantly campaign
  app.get('/api/marketing/by-campaign', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT COALESCE(instantly_campaign,'(untagged)') AS campaign,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE held IS TRUE)::int AS held,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
        FROM bookings GROUP BY 1 ORDER BY booked DESC`);
      res.json(rows.map(r => ({ ...r, fees: Number(r.fees) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // By self-report channel
  app.get('/api/marketing/by-channel', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { rows } = await pool.query(`
        SELECT COALESCE(attribution_channel,'organic') AS channel,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE became_client)::int AS clients,
               COALESCE(SUM(fee) FILTER (WHERE became_client),0)::numeric AS fees
        FROM bookings GROUP BY 1 ORDER BY booked DESC`);
      res.json(rows.map(r => ({ ...r, fees: Number(r.fees) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Time series
  app.get('/api/marketing/timeseries', async (req, res) => {
    if (!pool) return guard(res);
    const g = req.query.granularity === 'month' ? 'month' : 'week';
    try {
      const { rows } = await pool.query(`
        SELECT to_char(date_trunc('${g}', booked_on), 'YYYY-MM-DD') AS period,
               COUNT(*)::int AS booked,
               COUNT(*) FILTER (WHERE became_client)::int AS clients
        FROM bookings WHERE booked_on IS NOT NULL
        GROUP BY 1 ORDER BY 1`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Raw table (drill-down)
  app.get('/api/marketing/bookings', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const search = req.query.search || '';
      const channel = req.query.channel || '';
      const campaign = req.query.campaign || '';
      const { rows } = await pool.query(
        `SELECT id, booked_on, meeting_date, name, organization, email, told_us,
                attribution_channel, instantly_campaign, host, held, became_client, fee
         FROM bookings
         WHERE ($1='' OR name ILIKE '%'||$1||'%' OR organization ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%')
           AND ($2='' OR attribution_channel=$2)
           AND ($3='' OR instantly_campaign=$3)
         ORDER BY booked_on DESC NULLS LAST LIMIT 500`,
        [search, channel, campaign]
      );
      res.json(rows.map(r => ({ ...r, fee: Number(r.fee) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Manual override toggles (Held / Won)
  app.patch('/api/marketing/bookings/:id', async (req, res) => {
    if (!pool) return guard(res);
    try {
      const { held, became_client } = req.body || {};
      const cur = await pool.query('SELECT manual_override FROM bookings WHERE id=$1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
      const ov = { ...(cur.rows[0].manual_override || {}) };
      if (typeof held === 'boolean') ov.held = held;
      if (typeof became_client === 'boolean') ov.became_client = became_client;
      await pool.query('UPDATE bookings SET manual_override=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(ov), req.params.id]);
      await enrichBooking(pool, req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
