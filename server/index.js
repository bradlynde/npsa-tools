import express from 'express';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

let openai = null;
function getOpenAI() {
  if (!openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not configured');
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS letters (
      id          SERIAL PRIMARY KEY,
      client_name TEXT    NOT NULL DEFAULT 'Untitled',
      rep_name    TEXT    NOT NULL DEFAULT 'Unknown',
      doc_tab     TEXT    NOT NULL DEFAULT 'pre',
      form_data   JSONB   NOT NULL,
      saved_html  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reps (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
  `).catch(err => console.error('DB init error:', err.message));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dist')));

// AI clause polishing endpoint
app.post('/api/polish', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a legal contract drafting assistant for Nonprofit Security Advisors. Rewrite the following rough clause into polished, professional legal contract language. Return ONLY the polished clause text.\n\nRough clause: ${text}`
      }]
    });
    res.json({ result: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'AI service error' });
  }
});

// Template endpoints — serve JSON files so legal language can be updated
// without touching React code. Edit files in /templates/ and redeploy.
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const TEMPLATE_FILES = {
  'pre-award':  'pre-award.json',
  'in-house':   'in-house.json',
  'post-award': 'post-award.json',
};
app.get('/api/templates/:type', (req, res) => {
  const file = TEMPLATE_FILES[req.params.type];
  if (!file) return res.status(404).json({ error: 'Unknown template type' });
  try {
    res.type('json').send(readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
  } catch {
    res.status(500).json({ error: 'Could not load template' });
  }
});

// ── Letter storage endpoints ──────────────────────────────────────────────────

app.get('/api/letters/stats', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const [totalRes, byRepRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM letters'),
      pool.query('SELECT rep_name, COUNT(*)::int AS count FROM letters GROUP BY rep_name ORDER BY count DESC'),
    ]);
    res.json({ total: totalRes.rows[0].total, by_rep: byRepRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/letters', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const search = req.query.search || '';
    const result = await pool.query(
      `SELECT id, client_name, rep_name, doc_tab, updated_at FROM letters
       WHERE ($1 = '' OR client_name ILIKE '%' || $1 || '%' OR rep_name ILIKE '%' || $1 || '%')
       ORDER BY updated_at DESC`,
      [search]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const result = await pool.query('SELECT * FROM letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/letters', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { client_name, rep_name, doc_tab, form_data, saved_html } = req.body;
    const result = await pool.query(
      'INSERT INTO letters (client_name, rep_name, doc_tab, form_data, saved_html) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [client_name || 'Untitled', rep_name || 'Unknown', doc_tab || 'pre', JSON.stringify(form_data), saved_html || null]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { client_name, rep_name, doc_tab, form_data, saved_html } = req.body;
    await pool.query(
      'UPDATE letters SET client_name=$1, rep_name=$2, doc_tab=$3, form_data=$4, saved_html=$5, updated_at=NOW() WHERE id=$6',
      [client_name || 'Untitled', rep_name || 'Unknown', doc_tab || 'pre', JSON.stringify(form_data), saved_html || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/letters/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    await pool.query('DELETE FROM letters WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rep management endpoints ──────────────────────────────────────────────────

app.get('/api/reps', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const result = await pool.query('SELECT id, name FROM reps ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reps', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const result = await pool.query(
      'INSERT INTO reps (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name',
      [name.trim()]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Rep already exists' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reps/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Storage not configured' });
  try {
    await pool.query('DELETE FROM reps WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LOE Generator server running on port ${PORT}`);
});
