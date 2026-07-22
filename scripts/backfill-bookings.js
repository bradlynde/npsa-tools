// scripts/backfill-bookings.js
// One-time load of the existing Google Sheet rows into the bookings table.
//
// 1. In the Sheet: File → Share → Publish to web → whole sheet → CSV. Copy the URL.
// 2. Run (server must be running so enrichment fires):
//      SHEET_CSV_URL="https://docs.google.com/.../pub?output=csv" \
//      INGEST_URL="http://localhost:3001/api/marketing/bookings/ingest" \
//      ZAPIER_WEBHOOK_SECRET="<same secret you set on the server>" \
//      node scripts/backfill-bookings.js
//
// Idempotent: rows dedupe on email + meeting_date, so re-running is safe.

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const INGEST_URL = process.env.INGEST_URL || 'http://localhost:3001/api/marketing/bookings/ingest';
const SECRET = process.env.ZAPIER_WEBHOOK_SECRET || '';

if (!SHEET_CSV_URL) { console.error('Set SHEET_CSV_URL (published CSV link).'); process.exit(1); }

// minimal CSV parser (handles quoted fields with commas/newlines)
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const truthy = (v) => /^(y|yes|true|1)$/i.test((v || '').trim());
const norm = (h) => h.trim().toLowerCase();

(async () => {
  const csv = await fetch(SHEET_CSV_URL).then(r => r.text());
  const rows = parseCSV(csv).filter(r => r.some(c => c && c.trim()));
  const header = rows.shift().map(norm);
  const idx = (name) => header.indexOf(norm(name));

  const map = {
    booked_on: idx('Booked On'), meeting_date: idx('Meeting Date'), name: idx('Name'),
    email: idx('Email'), organization: idx('Organization'), told_us: idx('Told Us'),
    referred_by: idx('Referred By'), utm_source: idx('utm_source'), utm_medium: idx('utm_medium'),
    utm_campaign: idx('utm_campaign'), has_gclid: idx('Has GCLID'), host: idx('Host'),
  };

  let ok = 0, fail = 0;
  for (const r of rows) {
    const get = (k) => (map[k] >= 0 ? (r[map[k]] || '').trim() : '') || null;
    const body = {
      booked_on: get('booked_on'), meeting_date: get('meeting_date'), name: get('name'),
      email: get('email'), organization: get('organization'), told_us: get('told_us'),
      referred_by: get('referred_by'), utm_source: get('utm_source'), utm_medium: get('utm_medium'),
      utm_campaign: get('utm_campaign'), has_gclid: truthy(get('has_gclid')), host: get('host'),
    };
    if (!body.email && !body.name) continue;
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-zap-secret': SECRET },
        body: JSON.stringify(body),
      });
      res.ok ? ok++ : fail++;
    } catch { fail++; }
  }
  console.log(`Backfill complete. Imported/updated: ${ok}, failed: ${fail}`);
})();
