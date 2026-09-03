// MCP server for the Sales Toolbox backend.
//
// Exposes the data this service already serves — letters, reps, NSGP deadlines,
// pre-call bookings and the marketing figures — as Model Context Protocol tools,
// so Claude Code and Claude Desktop can read them directly. Streamable HTTP on
// POST /mcp, stateless (a fresh server per request, no session table to keep).
//
// Reads and, for keys allowed to, writes. Every write tool says so in its
// description and asks the caller to confirm with the person first; the MCP
// annotations (readOnlyHint / destructiveHint) say the same thing to clients that
// read them. Each write is logged with a fingerprint of the key that made it.
//
// The tools reach the data through the same HTTP routes the dashboard uses, over
// the loopback interface. That is deliberate: the marketing queries live inline in
// their route handlers, and re-implementing them here would be a second copy of
// the same SQL that could drift from what the dashboard shows. Going through the
// route means the number Claude reads is the number on the screen, and a write
// lands exactly the way the UI's own button would land it. The cost is one local
// hop per call, which is nothing next to the Postgres round trip behind it.
//
// Auth is a bearer key from MCP_API_KEYS (comma-separated, so each person gets
// their own and one can be revoked without rotating the rest). With the variable
// unset the endpoint refuses everything — the routes it fronts have no auth of
// their own, so this must never fall open. MCP_WRITE_KEYS, when set, narrows the
// write tools to the keys it lists; a key that is not on it never sees them.
//
//   registerMcp(app, { port })   // before the SPA fallback in index.js

import crypto, { webcrypto } from 'crypto';

// The MCP SDK reaches for the Web Crypto global (randomUUID and friends). Node 20
// has it; the Node 18 image this service runs on does not, and the failure is a
// "crypto is not defined" parse error on every request, after auth has already
// passed. Give it the same object Node 20 would.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { STATE_REFERENCE } from './nsgp-deadlines.js';
import { getBooking } from './precall-bookings.js';

export const MCP_PATH = '/mcp';
const SERVER_INFO = { name: 'npsa-tools', version: '1.1.0' };

const INSTRUCTIONS = `NPSA Sales Toolbox: Nonprofit Security Advisors' internal data.
Areas: engagement letters and proposals (letters_*), sales reps (rep*), NSGP grant deadlines by
state (nsgp_*), upcoming Calendly consultation bookings (precall_*), and the marketing dashboard
figures (marketing_*). Tools whose description begins with WRITE change data; confirm the exact
change with the user before calling one. Dollar figures are USD. Dates are ISO (YYYY-MM-DD)
unless a field says otherwise. State codes are two-letter USPS abbreviations.`;

const EXCLUSION_REASONS = ['unqualified', 'double_booking', 'cancelled', 'rescheduled'];

// ── Auth ──────────────────────────────────────────────────────────────────────

export function splitKeys(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function configuredKeys() {
  return splitKeys(process.env.MCP_API_KEYS || process.env.MCP_API_KEY);
}

export function keyMatches(presented, keys) {
  const a = Buffer.from(presented);
  return keys.some(k => {
    const b = Buffer.from(k);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// Enough of a hash to tell keys apart in a log line, not enough to recover one.
export function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function requireMcpKey(req, res, next) {
  const keys = configuredKeys();
  if (!keys.length) {
    return res.status(503).json({ error: 'MCP is not configured on this server (MCP_API_KEYS is unset)' });
  }
  const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!presented || !keyMatches(presented, keys)) {
    res.set('WWW-Authenticate', 'Bearer realm="npsa-tools"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Writes are open to every key unless MCP_WRITE_KEYS narrows them.
  const writeKeys = splitKeys(process.env.MCP_WRITE_KEYS);
  req.mcp = {
    actor: fingerprint(presented),
    canWrite: writeKeys.length ? keyMatches(presented, writeKeys) : true,
  };
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  // Central time, to match how the rest of the app talks about "today".
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Wraps a tool body so a thrown error becomes a tool error result rather than a
// protocol failure — the caller sees "Storage not configured" instead of a dropped
// request, and can decide what to do about it.
function tool(fn) {
  return async (args, extra) => {
    try { return ok(await fn(args || {}, extra)); }
    catch (err) { return fail(err?.message || String(err)); }
  };
}

function normState(s) {
  return String(s || '').trim().toUpperCase();
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ── Server ────────────────────────────────────────────────────────────────────

export function buildMcpServer({ api, canWrite = false, actor = 'unknown', log = console.log }) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  // A write tool that logs who did what. The record is the key fingerprint and
  // the arguments, which is the audit trail until keys map to people (phase 3).
  const write = (name, fn) => tool(async (args, extra) => {
    log(`[mcp] write ${name} by ${actor} ${JSON.stringify(args)}`);
    return fn(args, extra);
  });

  // ── Sales Toolbox: letters and reps ───────────────────────────────────────

  server.registerTool('letters_stats', {
    title: 'Letter stats',
    description: 'Count of engagement letters and total fees, with a per-rep leaderboard. Proposals and addendums are excluded, matching the dashboard.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/letters/stats')));

  server.registerTool('letters_search', {
    title: 'Search letters',
    description: 'List saved letters, proposals and addendums, newest first. Optional search matches client name or rep name (case-insensitive substring). Returns id, client_name, rep_name, doc_tab (pre-award | in-house | post-award | proposal | addendum) and updated_at. Use letter_get for the full record.',
    inputSchema: {
      search: z.string().optional().describe('Substring to match against client or rep name'),
      doc_tab: z.string().optional().describe('Only this document type, e.g. "proposal"'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows to return (default 50)'),
    },
    annotations: READ,
  }, tool(async ({ search = '', doc_tab, limit = 50 }) => {
    let rows = await api(`/letters?search=${encodeURIComponent(search)}`);
    if (doc_tab) rows = rows.filter(r => r.doc_tab === doc_tab);
    return { count: rows.length, letters: rows.slice(0, limit) };
  }));

  server.registerTool('letter_get', {
    title: 'Get letter',
    description: 'Full record for one saved letter: the form data it was generated from, fee total, rep, and timestamps. The rendered HTML is large and omitted unless include_html is true.',
    inputSchema: {
      id: z.number().int().describe('Letter id from letters_search'),
      include_html: z.boolean().optional().describe('Include the saved rendered HTML (default false)'),
    },
    annotations: READ,
  }, tool(async ({ id, include_html = false }) => {
    const row = await api(`/letters/${id}`);
    if (!include_html) {
      const { saved_html, ...rest } = row;
      return { ...rest, has_saved_html: Boolean(saved_html) };
    }
    return row;
  }));

  server.registerTool('reps_list', {
    title: 'List sales reps',
    description: 'The sales reps letters can be attributed to.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/reps')));

  server.registerTool('letter_template_get', {
    title: 'Get letter template',
    description: 'The current template definition for a document type: pre-award, in-house, post-award, proposal, or addendum. Shows the phases, sections and default fee structure the generator starts from.',
    inputSchema: {
      type: z.enum(['pre-award', 'in-house', 'post-award', 'proposal', 'addendum']),
    },
    annotations: READ,
  }, tool(async ({ type }) => api(`/templates/${type}`)));

  if (canWrite) {
    server.registerTool('letter_update', {
      title: 'Update letter details',
      description: 'WRITE. Confirm with the user before calling. Changes the client name, rep name and/or fee total on a saved letter. The generated content and form data are left exactly as they are; to change those, use the letter generator in the app. Returns the updated record (without HTML).',
      inputSchema: {
        id: z.number().int().describe('Letter id from letters_search'),
        client_name: z.string().min(1).optional(),
        rep_name: z.string().min(1).optional(),
        total_fee: z.number().min(0).optional().describe('Fee total in USD'),
      },
      annotations: WRITE,
    }, write('letter_update', async ({ id, client_name, rep_name, total_fee }) => {
      if (client_name === undefined && rep_name === undefined && total_fee === undefined) {
        throw new Error('Nothing to change: give client_name, rep_name and/or total_fee');
      }
      const cur = await api(`/letters/${id}`);
      const next = {
        client_name: client_name ?? cur.client_name,
        rep_name: rep_name ?? cur.rep_name,
        doc_tab: cur.doc_tab,
        form_data: cur.form_data,
        saved_html: cur.saved_html,
        total_fee: total_fee ?? cur.total_fee,
      };
      await api(`/letters/${id}`, { method: 'PUT', body: next });
      const { saved_html, ...rest } = await api(`/letters/${id}`);
      return { ...rest, has_saved_html: Boolean(saved_html) };
    }));

    server.registerTool('rep_add', {
      title: 'Add sales rep',
      description: 'WRITE. Confirm with the user before calling. Adds a sales rep by name so letters can be attributed to them. Fails if the name already exists.',
      inputSchema: { name: z.string().min(1).describe('Rep display name, e.g. "Chad Burgess"') },
      annotations: WRITE,
    }, write('rep_add', async ({ name }) => api('/reps', { method: 'POST', body: { name } })));

    server.registerTool('rep_remove', {
      title: 'Remove sales rep',
      description: 'WRITE, destructive. Confirm with the user before calling. Removes a rep from the list. Letters already attributed to them keep their rep name.',
      inputSchema: { id: z.number().int().describe('Rep id from reps_list') },
      annotations: DESTRUCTIVE,
    }, write('rep_remove', async ({ id }) => api(`/reps/${id}`, { method: 'DELETE' })));
  }

  // ── NSGP deadlines ────────────────────────────────────────────────────────

  server.registerTool('nsgp_deadlines_list', {
    title: 'NSGP deadlines',
    description: 'Curated NSGP application deadlines. Filter to one state (rows for that state plus federal "US" rows) and optionally to dates on or after today. Each row carries program, cycle_year, deadline, kind, note, source, confidence and layer. With a state, the state reference (SAA name, state-funded programs, last verified) is attached.',
    inputSchema: {
      state: z.string().length(2).optional().describe('Two-letter state code, e.g. "IL"'),
      upcoming_only: z.boolean().optional().describe('Only deadlines on or after today (default false)'),
    },
    annotations: READ,
  }, tool(async ({ state, upcoming_only = false }) => {
    const { deadlines, reference } = await api('/precall/deadlines');
    const st = normState(state);
    const today = todayIso();
    let rows = deadlines;
    if (st) rows = rows.filter(r => r.state === st || r.state === 'US');
    if (upcoming_only) rows = rows.filter(r => r.deadline && r.deadline >= today);
    return {
      today,
      checked_on: reference?.checkedOn || null,
      state: st || null,
      reference: st ? (reference?.states?.[st] || null) : undefined,
      count: rows.length,
      deadlines: rows,
    };
  }));

  server.registerTool('nsgp_state_reference', {
    title: 'NSGP state reference',
    description: 'For one state: the State Administrative Agency (SAA) that runs NSGP there, any state-funded security grant programs, and when that entry was last verified. Without a state, lists every covered state with its SAA short name, plus the states not covered.',
    inputSchema: {
      state: z.string().length(2).optional().describe('Two-letter state code'),
    },
    annotations: READ,
  }, tool(async ({ state }) => {
    const st = normState(state);
    if (st) {
      const entry = STATE_REFERENCE.states[st];
      if (!entry) return { state: st, covered: false, not_covered: STATE_REFERENCE.notCovered };
      return { state: st, covered: true, checked_on: STATE_REFERENCE.checkedOn, ...entry };
    }
    return {
      checked_on: STATE_REFERENCE.checkedOn,
      not_covered: STATE_REFERENCE.notCovered,
      states: Object.fromEntries(
        Object.entries(STATE_REFERENCE.states).map(([k, v]) => [k, { saa: v.saaShort || v.saa, programs: v.programs.length }]),
      ),
    };
  }));

  if (canWrite) {
    server.registerTool('nsgp_deadline_upsert', {
      title: 'Add or update NSGP deadline',
      description: 'WRITE. Confirm with the user before calling. Adds a deadline, or updates the one that already exists for the same state + program + cycle_year. The row is marked as manually maintained so automated correction passes leave it alone. Use "US" as the state for a federal FEMA date. Returns the row id.',
      inputSchema: {
        state: z.string().length(2).describe('Two-letter state code, or "US" for federal'),
        program: z.string().min(1).optional().describe('"federal" (default), or a state program acronym such as "NSGP-IL"'),
        cycle_year: z.number().int().min(2020).max(2040).describe('Grant cycle year, e.g. 2027'),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD. Omit to record the cycle with no date yet.'),
        kind: z.string().min(1).optional().describe('"sub_applicant" (default: the deadline nonprofits face) or "fema" (the SAA-to-FEMA date)'),
        note: z.string().optional(),
        source: z.string().optional().describe('URL or citation the date came from'),
        confidence: z.enum(['confirmed', 'illustrative']).optional().describe('Default "confirmed"'),
      },
      annotations: WRITE,
    }, write('nsgp_deadline_upsert', async (args) => {
      const body = { ...args, state: normState(args.state), cycleYear: args.cycle_year };
      delete body.cycle_year;
      return api('/precall/deadlines', { method: 'PUT', body });
    }));

    server.registerTool('nsgp_deadline_delete', {
      title: 'Delete NSGP deadline',
      description: 'WRITE, destructive. Confirm with the user before calling, naming the row. Removes one deadline row by id (from nsgp_deadlines_list). There is no undo.',
      inputSchema: { id: z.number().int() },
      annotations: DESTRUCTIVE,
    }, write('nsgp_deadline_delete', async ({ id }) => api(`/precall/deadlines/${id}`, { method: 'DELETE' })));
  }

  // ── Pre-call bookings ─────────────────────────────────────────────────────

  server.registerTool('precall_bookings_list', {
    title: 'Upcoming bookings',
    description: 'Upcoming Calendly consultation bookings with the facts the pre-call notes generator uses: organisation, state, website, invitee contact details, host and start time. Served from a 60-second cache unless refresh is true.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Bypass the cache and ask Calendly now'),
      limit: z.number().int().min(1).max(40).optional().describe('Max bookings (default 40)'),
    },
    annotations: READ,
  }, tool(async ({ refresh = false, limit = 40 }) => {
    const data = await api(`/precall/bookings${refresh ? '?refresh=1' : ''}`);
    return { cached: data.cached, count: data.bookings.length, bookings: data.bookings.slice(0, limit) };
  }));

  server.registerTool('precall_booking_get', {
    title: 'Get booking',
    description: 'One Calendly booking by its event URI (from precall_bookings_list), fetched fresh.',
    inputSchema: {
      event_uri: z.string().url().describe('Calendly scheduled_events URI'),
    },
    annotations: READ,
  }, tool(async ({ event_uri }) => {
    if (!process.env.CALENDLY_API_TOKEN) throw new Error('Calendly is not connected');
    const booking = await getBooking(event_uri);
    if (!booking) throw new Error('Booking not found');
    return booking;
  }));

  // ── Marketing dashboard ───────────────────────────────────────────────────

  server.registerTool('marketing_overview', {
    title: 'Marketing overview',
    description: 'The headline figures from the marketing dashboard in one call: booking stats, the funnel, grant-application stats from Salesforce, and when each Salesforce sync last ran. Start here before the more specific marketing_* tools.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => {
    const [stats, funnel, applications, sync] = await Promise.all([
      api('/marketing/stats'), api('/marketing/funnel'),
      api('/marketing/applications/stats'), api('/marketing/sync/status'),
    ]);
    return { stats, funnel, applications, sync };
  }));

  server.registerTool('marketing_by_campaign', {
    title: 'Bookings by campaign',
    description: 'Bookings, held meetings, LOEs and wins grouped by Instantly campaign. Grouped on campaign id so renamed campaigns stay together.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/marketing/by-campaign')));

  server.registerTool('marketing_by_channel', {
    title: 'Bookings by channel',
    description: 'Bookings, held meetings, LOEs and wins grouped by acquisition channel (cold email, ads, referral, and so on).',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/marketing/by-channel')));

  server.registerTool('marketing_timeseries', {
    title: 'Marketing time series',
    description: 'Trend data. series "bookings" is the funnel over time by week or month. series "sales" is won revenue over time by month or quarter.',
    inputSchema: {
      series: z.enum(['bookings', 'sales']).optional().describe('Which series (default "bookings")'),
      granularity: z.enum(['week', 'month', 'quarter']).optional().describe('bookings: week | month. sales: month | quarter.'),
    },
    annotations: READ,
  }, tool(async ({ series = 'bookings', granularity }) => {
    const path = series === 'sales' ? '/marketing/sales-timeseries' : '/marketing/timeseries';
    const q = granularity ? `?granularity=${encodeURIComponent(granularity)}` : '';
    return api(`${path}${q}`);
  }));

  server.registerTool('marketing_bookings', {
    title: 'Booking records',
    description: 'Individual booking rows with their attribution (channel, campaign), Held and LOE flags, and any linked win. Filter by search text, channel or campaign. The id here is what marketing_booking_update takes.',
    inputSchema: {
      search: z.string().optional().describe('Substring match on the booking'),
      channel: z.string().optional(),
      campaign: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100)'),
    },
    annotations: READ,
  }, tool(async ({ search = '', channel = '', campaign = '', limit = 100 }) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (channel) params.set('channel', channel);
    if (campaign) params.set('campaign', campaign);
    const qs = params.toString();
    const rows = await api(`/marketing/bookings${qs ? `?${qs}` : ''}`);
    const list = Array.isArray(rows) ? rows : (rows.bookings || rows.rows || []);
    return { count: list.length, bookings: list.slice(0, limit) };
  }));

  server.registerTool('marketing_untracked_wins', {
    title: 'Untracked wins',
    description: 'Salesforce wins that could not be matched to a tracked booking. Most predate funnel tracking (late February 2026); recent ones may be attribution gaps worth a look.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/marketing/untracked-wins')));

  server.registerTool('marketing_revenue_quality', {
    title: 'Revenue quality check',
    description: 'Reconciliation between the two revenue totals (bookings-attributed vs Salesforce). No longer on the dashboard; use it to confirm the totals still agree.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/marketing/revenue-quality')));

  if (canWrite) {
    server.registerTool('marketing_booking_update', {
      title: 'Update booking flags',
      description: `WRITE. Confirm with the user before calling. Sets manual overrides on one booking, the same ones the dashboard's toggles set: held (the meeting happened), became_client (an LOE was signed), an exclusion reason that drops it from the totals (${EXCLUSION_REASONS.join(', ')}; pass "" to clear), or a channel / campaign override ("" hands it back to automatic detection; setting a campaign also clears any channel override). Only the fields given are changed. The booking is re-enriched afterwards.`,
      inputSchema: {
        id: z.number().int().describe('Booking id from marketing_bookings'),
        held: z.boolean().optional(),
        became_client: z.boolean().optional(),
        exclusion: z.enum([...EXCLUSION_REASONS, '']).optional(),
        channel: z.string().optional(),
        campaign: z.string().optional(),
      },
      annotations: WRITE,
    }, write('marketing_booking_update', async ({ id, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error('Nothing to change: give at least one of held, became_client, exclusion, channel, campaign');
      return api(`/marketing/bookings/${id}`, { method: 'PATCH', body });
    }));

    server.registerTool('marketing_refresh', {
      title: 'Refresh marketing data',
      description: 'WRITE. Confirm with the user before calling. Re-enriches bookings from Instantly and Calendly, the same as the dashboard\'s "Refresh data" button. Default refreshes only stale rows and waits for the result. all=true sweeps every booking in the background and returns at once; it can take several minutes and only one sweep runs at a time.',
      inputSchema: { all: z.boolean().optional().describe('Full sweep instead of stale rows only (default false)') },
      annotations: WRITE,
    }, write('marketing_refresh', async ({ all = false }) => api(`/marketing/enrich${all ? '?all=1' : ''}`, { method: 'POST', body: {} })));
  }

  return server;
}

// ── Express wiring ────────────────────────────────────────────────────────────

export function registerMcp(app, { port }) {
  const base = () => `http://127.0.0.1:${typeof port === 'function' ? port() : port}/api`;

  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(`${base()}${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      const msg = data && typeof data === 'object' && data.error ? data.error : `HTTP ${r.status} from ${path}`;
      throw new Error(msg);
    }
    return data;
  }

  app.post(MCP_PATH, requireMcpKey, async (req, res) => {
    const server = buildMcpServer({ api, canWrite: req.mcp.canWrite, actor: req.mcp.actor });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: nothing to resume, nothing to leak
      enableJsonResponse: true,
    });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request error:', err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  // Stateless servers have no stream to resume and no session to end.
  const notAllowed = (req, res) => res.status(405).json({
    jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null,
  });
  app.get(MCP_PATH, requireMcpKey, notAllowed);
  app.delete(MCP_PATH, requireMcpKey, notAllowed);
}
