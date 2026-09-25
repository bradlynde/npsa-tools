// MCP server for the Sales Toolbox backend.
//
// Exposes the data this service already serves — letters, reps, pre-call bookings,
// the marketing figures, grant clients and the grant knowledge base — as Model
// Context Protocol tools, so Claude Code and Claude Desktop can read them
// directly. Streamable HTTP on POST /mcp, stateless (a fresh server per request,
// no session table to keep).
//
// Reads and, for keys allowed to, writes. Every write tool says so in its
// description and asks the caller to confirm with the person first; the MCP
// annotations (readOnlyHint / destructiveHint) say the same thing to clients that
// read them. Each write is logged with the caller (a name or the key's
// fingerprint), the argument names (never their values) and the outcome.
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
import { getBooking } from './precall-bookings.js';
import { KINDS, NOTE_CATEGORIES } from './grant-knowledge-kinds.js';

export const MCP_PATH = '/mcp';
const SERVER_INFO = { name: 'npsa-tools', version: '1.6.0' };

const INSTRUCTIONS = `NPSA Sales Toolbox: Nonprofit Security Advisors' internal data.
Areas: engagement letters and proposals (letters_*), sales reps (rep*), upcoming Calendly consultation
bookings (precall_*), the marketing dashboard figures (marketing_*), in-house NSGP grant-writing clients
with their intake forms (clients_*, client_*, intake_*), and the grant knowledge base (gk_*): per state,
DC, territory and "US", who runs NSGP and the state-funded programs, what a submission requires, past and
coming deadlines and funding, contacts, and gotchas. Use gk_* for anything about a state. Every gk record says whether
a person has verified it; say so when you quote one that is unverified or stale. What you write to the
knowledge base lands unverified and must carry a source_url (or a reason saying the user told you from
their own experience); never mark your own research verified. Tools whose description begins with WRITE change data; confirm the exact
change with the user before calling one. Before seeding intake answers, look the keys up with
intake_questions; a seed naming a key that is not in the catalog is refused. Dollar figures are USD. Dates are ISO (YYYY-MM-DD)
unless a field says otherwise. State codes are two-letter USPS abbreviations.`;

const EXCLUSION_REASONS = ['unqualified', 'double_booking', 'cancelled', 'rescheduled'];
const CLIENT_STATUSES = ['active', 'submitted', 'cancelled', 'closed'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Shared shapes. Each is one zod instance, so the SDK's JSON Schema output writes it
// out once per tool and points every later use at it with a $ref.
const contactShape = z.object({
  name: z.string().optional(),
  email: z.string().email(),
  role: z.string().optional().describe('e.g. "Executive Pastor"; NPSA people "Consultant", never "Sales rep" (the client sees it)'),
  phone: z.string().optional(),
});
const contactList = z.array(contactShape);
const documentShape = z.object({ key: z.string().regex(/^up_[a-z0-9_]{2,40}$/), label: z.string().min(1).max(140), hint: z.string().max(80).optional() });
const applicationShape = z.object({
  id: z.string().regex(/^a\d{1,2}$/).optional().describe('Keep when editing; omit for a new one'),
  program: z.string().min(1).describe('"NSGP-S", "NSGP-UA", or a state program key (gk_state_get)'),
  cycle: z.string().max(24).optional().describe('e.g. "FY2027"'),
  sites: z.array(z.number().int().min(1).max(3)).min(1).optional().describe('Locations-tab site numbers; default [1]'),
  status: z.enum(['active', 'planned', 'submitted', 'awarded', 'not_awarded', 'withdrawn']).optional().describe('Default active; planned = a later cycle'),
});

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

// MCP_KEY_NAMES maps a key's fingerprint to the person holding it, e.g.
// "ab12cd34:Stuart,ef567890:Brad", so an audit line and an edit history can name
// someone. It is keyed by fingerprint rather than by key so the variable holds
// nothing worth stealing. A key with no entry is still known by its fingerprint.
export function nameFor(key) {
  const fp = fingerprint(key);
  for (const pair of splitKeys(process.env.MCP_KEY_NAMES)) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(0, i).trim().toLowerCase() === fp) return cleanActor(pair.slice(i + 1)) || fp;
  }
  return fp;
}

// An actor is a label in a log line and a history row, never markup or a path.
export function cleanActor(raw) {
  return String(raw || '').replace(/[^\p{L}\p{N} .'_:-]/gu, '').trim().slice(0, 40);
}

// ACTOR_PROXY_KEYS lists the fingerprints of keys that may say who they are
// acting for with an X-Actor header. In practice that is the one key Vercel holds:
// the toolbox has already verified the person's login, and the key alone would
// otherwise make every web edit look like it came from the same caller. Any other
// key presenting X-Actor is ignored and named for itself.
export function mayAssertActor(key) {
  const fp = fingerprint(key);
  return splitKeys(process.env.ACTOR_PROXY_KEYS).some(k => k.toLowerCase() === fp);
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
    actor: nameFor(presented),
    canWrite: writeKeys.length ? keyMatches(presented, writeKeys) : true,
  };
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const DETAILS_CAP = 2000;

// The text of a failed call: the message, then whatever else the route said (a
// 409's current record, the unknown_keys of a refused seed), capped so one bad
// call cannot flood the conversation.
export function errorText(err) {
  const message = err?.message || String(err);
  const details = err?.details && typeof err.details === 'object' && Object.keys(err.details).length ? JSON.stringify(err.details) : '';
  if (!details) return message;
  return `${message}\nDetails: ${details.length > DETAILS_CAP ? `${details.slice(0, DETAILS_CAP)}… (truncated)` : details}`;
}

// Wraps a tool body so a thrown error becomes a tool error result rather than a
// protocol failure — the caller sees "Storage not configured" instead of a dropped
// request, and can decide what to do about it.
function tool(fn) {
  return async (args, extra) => {
    try { return ok(await fn(args || {}, extra)); }
    catch (err) { return fail(errorText(err)); }
  };
}

// An audit line may say that a write failed and why, but never repeat what was
// written: email addresses, phone and EIN-like digit runs are masked and the
// message is cut short.
export function redact(message) {
  return String(message || '')
    .replace(/[^\s"'<>(),;]+@[^\s"'<>(),;]+/g, '<email>')
    .replace(/\+?\(?\d[\d\s().-]{5,}\d/g, '<number>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function normState(s) {
  return String(s || '').trim().toUpperCase();
}

// destructiveHint only means something when readOnlyHint is false, so reads leave it out.
const READ = { readOnlyHint: true, openWorldHint: false };
// WRITE: calling twice with the same arguments leaves the same state (a PATCH).
// WRITE_ONCE: each call adds or does something again (a new row, a new revision, a sweep).
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ONCE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
// Sends an email to someone outside NPSA.
const SENDS_EMAIL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// ── Server ────────────────────────────────────────────────────────────────────

export function buildMcpServer({ api, canWrite = false, actor = 'unknown', log = console.log }) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  // A write tool that logs who did what, after the call: the caller (a name when
  // MCP_KEY_NAMES maps the key, its fingerprint otherwise), the names of the
  // arguments given, and ok or the error. Never the values: those carry client
  // emails, phones, EINs and record contents, and the route's own log names the client.
  const write = (name, fn) => tool(async (args, extra) => {
    const keys = Object.keys(args || {}).filter(k => args[k] !== undefined).sort().join(',');
    try {
      const out = await fn(args, extra);
      log(`[mcp] write ${name} by ${actor} args=[${keys}] ok`);
      return out;
    } catch (err) {
      log(`[mcp] write ${name} by ${actor} args=[${keys}] error: ${redact(err?.message || err)}`);
      throw err;
    }
  });

  // ── Sales Toolbox: letters and reps ───────────────────────────────────────

  server.registerTool('letters_stats', {
    title: 'Letter stats',
    description: 'Engagement-letter count and total fees, with a per-rep leaderboard. Proposals and addendums excluded, as on the dashboard.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/letters/stats')));

  server.registerTool('letters_search', {
    title: 'Search letters',
    description: 'Saved letters, proposals and addendums, newest first: id, client_name, rep_name, doc_tab (pre-award, in-house, post-award, proposal, addendum), updated_at. search matches client or rep name (case-insensitive). letter_get has the full record.',
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
    description: 'One saved letter: the form data it was generated from, fee total, rep, timestamps. The rendered HTML is large and left out unless include_html is true.',
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
    description: 'The template a document type starts from: phases, sections and default fee structure.',
    inputSchema: {
      type: z.enum(['pre-award', 'in-house', 'post-award', 'proposal', 'addendum']),
    },
    annotations: READ,
  }, tool(async ({ type }) => api(`/templates/${type}`)));

  if (canWrite) {
    server.registerTool('letter_update', {
      title: 'Update letter details',
      description: 'WRITE. Confirm with the user before calling. Changes the client name, rep name and/or fee total on a saved letter. Content and form data are untouched (the letter generator in the app changes those). Returns the updated record without HTML.',
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
      // Only the named fields, in one write, so nothing edited in the generator meanwhile is lost.
      const body = Object.fromEntries(Object.entries({ client_name, rep_name, total_fee }).filter(([, v]) => v !== undefined));
      await api(`/letters/${id}`, { method: 'PATCH', body });
      const { saved_html, ...rest } = await api(`/letters/${id}`);
      return { ...rest, has_saved_html: Boolean(saved_html) };
    }));

    server.registerTool('rep_add', {
      title: 'Add sales rep',
      description: 'WRITE. Confirm with the user before calling. Adds a sales rep letters can be attributed to. Fails if the name exists.',
      inputSchema: { name: z.string().min(1).describe('Rep display name, e.g. "Chad Burgess"') },
      annotations: WRITE_ONCE,
    }, write('rep_add', async ({ name }) => api('/reps', { method: 'POST', body: { name } })));

    server.registerTool('rep_remove', {
      title: 'Remove sales rep',
      description: 'WRITE, destructive. Confirm with the user before calling. Removes a rep. Their letters keep the rep name.',
      inputSchema: { id: z.number().int().describe('Rep id from reps_list') },
      annotations: DESTRUCTIVE,
    }, write('rep_remove', async ({ id }) => api(`/reps/${id}`, { method: 'DELETE' })));
  }

  // The nsgp_* tools are gone. nsgp_deadlines_list and nsgp_state_reference read
  // the grant knowledge base through an older shape; gk_* reads it directly. A
  // deadline is a gk record (gk_record_upsert, kind "deadline").

  // ── Grant knowledge ───────────────────────────────────────────────────────
  //
  // Seven reads and four writes over /api/grant-knowledge. One upsert covers every
  // kind of record rather than a tool per kind: the server validates by kind either
  // way, and twenty near-identical tools would crowd out the rest of the list.

  const GK = '/grant-knowledge';
  const gkState = z.string().min(2).max(2).describe('State code, DC, PR, GU, VI, AS, MP, or US (federal)');
  // What Claude needs of a record: its id and version to write back, its trust, its facts.
  const slim = r => (r && typeof r === 'object' && 'version' in r && 'data' in r ? {
    id: r.id, kind: r.kind, key: r.key, version: r.version, status: r.effective_status, ...(r.unverified_fields?.length ? { unverified_fields: r.unverified_fields } : {}),
    ...(r.source_url ? { source_url: r.source_url } : {}), ...(r.baseline ? { baseline: r.baseline } : {}), ...(r.inherited_from ? { inherited_from: r.inherited_from } : {}),
    updated: `${r.updated_by} ${String(r.updated_at).slice(0, 10)}`, data: r.data,
    ...Object.fromEntries(['requirements', 'inherited_requirements', 'cycles', 'deadlines', 'contacts', 'notes', 'sources'].filter(f => Array.isArray(r[f])).map(f => [f, r[f].map(slim)])),
  } : r);

  server.registerTool('gk_overview', {
    title: 'Grant knowledge: every jurisdiction',
    description: 'One row per jurisdiction (57): SAA, programs and their status, whether a state-funded program is active, cycle state (open, soon, closed, unknown), next deadline, how much is verified. Start here for "which states…" questions.',
    inputSchema: {
      cycle_state: z.enum(['open', 'soon', 'closed', 'unknown']).optional().describe('Only jurisdictions in this state'),
      has_state_program: z.boolean().optional().describe('Only jurisdictions with (or without) an active state-funded program'),
    },
    annotations: READ,
  }, tool(async ({ cycle_state, has_state_program }) => {
    let rows = (await api(`${GK}/overview`)).jurisdictions;
    if (cycle_state) rows = rows.filter(r => r.cycle_state === cycle_state);
    if (has_state_program !== undefined) rows = rows.filter(r => r.has_state_program === has_state_program);
    return { count: rows.length, jurisdictions: rows };
  }));

  server.registerTool('gk_state_get', {
    title: 'Grant knowledge: one jurisdiction, in full',
    description: 'One jurisdiction in full, structured: SAA record, programs with own and inherited requirements, cycles and staged deadlines, contacts, notes (gotchas, eligibility, scoring, prohibited costs, history, open questions), sources. Each record has id and version (to write back) and status (verified, unverified, stale). sections keeps it small; gk_state_brief is the prose version.',
    inputSchema: {
      state: gkState,
      sections: z.array(z.enum(['programs', 'contacts', 'notes', 'sources'])).optional().describe('Default: all four'),
      program: z.string().optional().describe('Only this program, e.g. "NSGP-S" or "SCAHC"'),
    },
    annotations: READ,
  }, tool(async ({ state, sections, program }) => {
    const doc = await api(`${GK}/jurisdictions/${normState(state)}`);
    const want = new Set(sections?.length ? sections : ['programs', 'contacts', 'notes', 'sources']);
    const programs = doc.programs.filter(p => !program || p.key.toLowerCase() === program.toLowerCase());
    return {
      code: doc.code, name: doc.name, cycle_state: doc.cycle_state, next_deadline: doc.next_deadline, freshness: doc.freshness, open_questions: doc.open_questions,
      jurisdiction: slim(doc.jurisdiction),
      ...(want.has('programs') ? { programs: programs.map(slim) } : { programs: doc.programs.map(p => ({ id: p.id, key: p.key, name: p.data.name })) }),
      ...(want.has('contacts') ? { contacts: doc.contacts.map(slim) } : {}),
      ...(want.has('notes') ? { notes: doc.notes.map(slim) } : {}),
      ...(want.has('sources') ? { sources: doc.sources.map(slim) } : {}),
    };
  }));

  server.registerTool('gk_state_brief', {
    title: 'Grant knowledge: state brief',
    description: 'One jurisdiction as a markdown brief for a grant writer: what ends an application first, then each program (caps, submission, registration and document checklists with hard gates, cycles, deadlines), contacts, gotchas and notes, sources. Unverified and stale facts are marked inline.',
    inputSchema: { state: gkState },
    annotations: READ,
  }, async ({ state }) => {
    try { return { content: [{ type: 'text', text: await api(`${GK}/jurisdictions/${normState(state)}?format=markdown`) }] }; }
    catch (err) { return fail(errorText(err)); }
  });

  server.registerTool('gk_requirements', {
    title: 'Grant knowledge: submission checklist',
    description: 'What a submission needs in one jurisdiction, per program: registration steps and documents, federal baseline merged with state additions, hard gates and long lead times first. Each line: owner (client or npsa), lead_time_days, hard_gate, format, phase, verified. Kickoff builds its Asana tasks and client checklist from it.',
    inputSchema: { state: gkState, program: z.string().optional().describe('e.g. "NSGP-S"; default every program') },
    annotations: READ,
  }, tool(async ({ state, program }) => api(`${GK}/jurisdictions/${normState(state)}/requirements${program ? `?program=${encodeURIComponent(program)}` : ''}`)));

  server.registerTool('gk_search', {
    title: 'Grant knowledge: search',
    description: 'Search every record in every jurisdiction; all terms must match. Returns jurisdiction, kind, record id, title, snippet.',
    inputSchema: {
      query: z.string().min(2),
      state: gkState.optional(),
      kinds: z.array(z.enum(KINDS)).optional(),
    },
    annotations: READ,
  }, tool(async ({ query, state, kinds }) => {
    const qs = new URLSearchParams({ q: query });
    if (state) qs.set('state', normState(state));
    if (kinds?.length) qs.set('kinds', kinds.join(','));
    return api(`${GK}/search?${qs}`);
  }));

  server.registerTool('gk_needs_attention', {
    title: 'Grant knowledge: what needs a person',
    description: 'The work queue: unverified records (and verified ones with fields changed since), stale verifications, deadlines in the window, open questions, holes (a jurisdiction with no contact, an active program with no cycle). Picks what to research or confirm next.',
    inputSchema: { state: gkState.optional(), days: z.number().int().min(1).max(365).optional().describe('Deadline window in days (default 45)') },
    annotations: READ,
  }, tool(async ({ state, days }) => {
    const qs = new URLSearchParams();
    if (state) qs.set('state', normState(state));
    if (days) qs.set('days', String(days));
    return api(`${GK}/needs-attention?${qs}`);
  }));

  server.registerTool('gk_files_list', {
    title: 'Grant knowledge: attachments',
    description: 'Files kept for a jurisdiction (NOFOs, SAA checklists, portal screenshots): filename, label, type, size, who added it and when, Drive link if mirrored. Added from the toolbox. record_id narrows to one record.',
    inputSchema: { state: gkState, record_id: z.number().int().optional() },
    annotations: READ,
  }, tool(async ({ state, record_id }) => {
    const qs = new URLSearchParams({ jurisdiction: normState(state) });
    if (record_id) qs.set('record_id', String(record_id));
    const r = await api(`${GK}/files?${qs}`);
    // The toolbox download link is minted for the browser that asked and expires
    // in minutes; from here it would be a link to this process's own loopback.
    return { files: (r.files || []).map(({ download_url, ...f }) => f) };
  }));

  server.registerTool('gk_revisions', {
    title: 'Grant knowledge: change history',
    description: 'Who changed what, newest first, for one record, one jurisdiction or everything: action, actor and how they came in (user = toolbox, mcp = Claude, import), fields changed, before and after, reason. gk_revert takes a revision id. limit defaults: 200 for a record, 50 for a jurisdiction, 20 for everything.',
    inputSchema: { record_id: z.number().int().optional(), state: gkState.optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: READ,
  }, tool(async ({ record_id, state, limit }) => {
    const qs = limit ? `?limit=${limit}` : '';
    if (record_id) {
      // The per-record route always answers with up to 200; honour limit here.
      const r = await api(`${GK}/records/${record_id}/revisions`);
      return limit && Array.isArray(r?.revisions) ? { ...r, revisions: r.revisions.slice(0, limit) } : r;
    }
    return api(state ? `${GK}/jurisdictions/${normState(state)}/revisions${qs}` : `${GK}/revisions${qs}`);
  }));

  if (canWrite) {
    server.registerTool('gk_record_upsert', {
      title: 'Grant knowledge: add or change a record',
      description: `WRITE. Confirm with the user before calling. Adds a record to a jurisdiction, or changes the one with the same key. It lands UNVERIFIED (on a verified record, only changed fields are flagged). Give source_url (where the fact came from) or a reason saying the user stated it from their own experience. To change a record pass its version (gk_state_get); if edited since, the call fails with the current record. In data, null clears a field; a field the kind lacks is refused with the list it has (other facts go in data.extra). A note needs category (${NOTE_CATEGORIES.join(', ')}) and title. Parents: program, contact, note, source hang under the jurisdiction (contact, note, source may name a program); requirement and cycle under a program; deadline under a program's cycle.`,
      inputSchema: {
        state: gkState,
        kind: z.enum(KINDS),
        program: z.string().optional().describe('Parent program key, e.g. "NSGP-S". Required for requirement, cycle, deadline'),
        cycle: z.string().optional().describe('Cycle key, e.g. "2027". Required for a deadline'),
        key: z.string().optional().describe('Key within the parent. Required for a program (e.g. "SCAHC"); else derived from label or title'),
        data: z.record(z.any()).describe('The fields to set, per the kind'),
        version: z.number().int().optional().describe('Required when the record already exists'),
        source_url: z.string().url().optional(),
        reason: z.string().max(1000).optional().describe('Why, in a sentence. Shown in the history'),
        origin: z.enum(['mcp', 'research']).optional().describe('"research" when you found it yourself on the web; default "mcp"'),
      },
      annotations: WRITE_ONCE,
    }, write('gk_record_upsert', async ({ state, kind, program, cycle, key, data, version, source_url, reason, origin }) => {
      const code = normState(state);
      const doc = await api(`${GK}/jurisdictions/${code}`);
      let parent = null;
      if (['requirement', 'cycle', 'deadline'].includes(kind) && !program) throw new Error(`A ${kind} hangs under a program: pass program. ${code} has: ${doc.programs.map(p => p.key).join(', ') || 'none'}`);
      if (program && kind !== 'program' && kind !== 'jurisdiction') {
        parent = doc.programs.find(p => p.key.toLowerCase() === program.toLowerCase());
        if (!parent) throw new Error(`${code} has no program "${program}". It has: ${doc.programs.map(p => p.key).join(', ') || 'none'}`);
        if (kind === 'deadline') {
          if (!cycle) throw new Error(`A deadline hangs under a cycle: pass cycle. ${parent.key} has: ${parent.cycles.map(c => c.key).join(', ') || 'none (add the cycle first)'}`);
          const c = parent.cycles.find(x => x.key === String(cycle));
          if (!c) throw new Error(`${parent.key} has no cycle "${cycle}". It has: ${parent.cycles.map(x => x.key).join(', ') || 'none (add the cycle first)'}`);
          parent = c;
        }
      }
      const pool = kind === 'jurisdiction' ? [doc.jurisdiction].filter(Boolean)
        : kind === 'program' ? doc.programs
        : kind === 'deadline' ? parent.deadlines
        : kind === 'requirement' ? parent.requirements
        : kind === 'cycle' ? parent.cycles
        : (parent ? parent[`${kind}s`] : doc[`${kind}s`]);
      const existing = kind === 'jurisdiction' ? pool[0] : (key ? pool.find(r => r.key.toLowerCase() === String(key).toLowerCase()) : null);
      if (existing) {
        if (version === undefined) {
          // The current data goes in details, not the message, so the audit line never carries it.
          throw Object.assign(new Error(`${kind} "${existing.key}" already exists at version ${existing.version}. Pass version: ${existing.version} to change it.`), { details: { current: existing.data } });
        }
        return slim(await api(`${GK}/records/${existing.id}`, { method: 'PATCH', body: { version, data, source_url, reason } }));
      }
      return slim(await api(`${GK}/records`, { method: 'POST', body: { jurisdiction: code, kind, parent_id: parent?.id, key, data, source_url, reason, origin } }));
    }));

    server.registerTool('gk_mark_verified', {
      title: 'Grant knowledge: mark verified',
      description: 'WRITE. Confirm with the user before calling. Marks one record verified in the user\'s name, only when the user has confirmed the fact themselves (checked the source, or knows it first-hand), never on your own research. verified: false takes it back.',
      inputSchema: { record_id: z.number().int(), version: z.number().int(), verified: z.boolean().optional().describe('Default true'), reason: z.string().max(1000).optional() },
      annotations: WRITE,
    }, write('gk_mark_verified', async ({ record_id, version, verified, reason }) => slim(await api(`${GK}/records/${record_id}/${verified === false ? 'unverify' : 'verify'}`, { method: 'POST', body: { version, reason } }))));

    server.registerTool('gk_record_archive', {
      title: 'Grant knowledge: archive or restore a record',
      description: 'WRITE. Confirm with the user before calling, naming the record. Takes a record and everything under it out of view, or with restore: true brings it back. Nothing is deleted; the history keeps it.',
      inputSchema: { record_id: z.number().int(), version: z.number().int(), restore: z.boolean().optional(), reason: z.string().max(1000).optional() },
      annotations: WRITE,
    }, write('gk_record_archive', async ({ record_id, version, restore, reason }) => slim(await api(`${GK}/records/${record_id}/${restore ? 'restore' : 'archive'}`, { method: 'POST', body: { version, reason } }))));

    server.registerTool('gk_revert', {
      title: 'Grant knowledge: revert a change',
      description: 'WRITE. Confirm with the user before calling, saying what will be undone. Puts a record back to before one revision (from gk_revisions), as a new revision that can itself be undone. version is the record\'s current version.',
      inputSchema: { revision_id: z.number().int(), version: z.number().int(), reason: z.string().max(1000).optional() },
      annotations: WRITE,
    }, write('gk_revert', async ({ revision_id, version, reason }) => slim(await api(`${GK}/revisions/${revision_id}/revert`, { method: 'POST', body: { version, reason } }))));
  }

  // ── Pre-call bookings ─────────────────────────────────────────────────────

  server.registerTool('precall_bookings_list', {
    title: 'Upcoming bookings',
    description: 'Upcoming Calendly consultations with pre-call facts: organisation, state, website, invitee contact, host, start time. 60-second cache unless refresh.',
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
    description: 'One Calendly booking by event URI (from precall_bookings_list), fetched fresh.',
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
    description: 'The marketing dashboard\'s headline figures: booking stats, the funnel, Salesforce grant-application stats, and when each Salesforce sync last ran. Start here.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => {
    const [stats, funnel, applications, sync] = await Promise.all([
      api('/marketing/stats'), api('/marketing/funnel'),
      api('/marketing/applications/stats'), api('/marketing/sync/status'),
    ]);
    return { stats, funnel, applications, sync };
  }));

  server.registerTool('marketing_breakdown', {
    title: 'Bookings by campaign or channel',
    description: 'Bookings, held meetings, LOEs and wins by Instantly campaign (grouped on id, so renamed campaigns stay together) or by channel (cold email, ads, referral…).',
    inputSchema: { by: z.enum(['campaign', 'channel']) },
    annotations: READ,
  }, tool(async ({ by }) => api(by === 'channel' ? '/marketing/by-channel' : '/marketing/by-campaign')));

  server.registerTool('marketing_timeseries', {
    title: 'Marketing time series',
    description: 'Trends: "bookings" is the funnel by week or month; "sales" is won revenue by month or quarter.',
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
    description: 'Booking rows with attribution (channel, campaign), Held and LOE flags, and any linked win. The id is what marketing_booking_update takes.',
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
    description: 'Salesforce wins with no matching tracked booking. Most predate funnel tracking (late February 2026); recent ones may be attribution gaps.',
    inputSchema: {},
    annotations: READ,
  }, tool(async () => api('/marketing/untracked-wins')));

  if (canWrite) {
    server.registerTool('marketing_booking_update', {
      title: 'Update booking flags',
      description: 'WRITE. Confirm with the user before calling. Sets the dashboard\'s manual overrides on one booking; only the fields given change: held (the meeting happened), became_client (an LOE was signed), exclusion (drops it from the totals; "" clears), channel or campaign ("" hands it back to automatic detection; a campaign also clears any channel override). The booking is re-enriched afterwards.',
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
      description: 'WRITE. Confirm with the user before calling. Re-enriches bookings from Instantly and Calendly, like the dashboard\'s "Refresh data". Default: stale rows only, waiting for the result. all=true sweeps every booking in the background and returns at once (several minutes; one sweep at a time).',
      inputSchema: { all: z.boolean().optional().describe('Full sweep instead of stale rows only (default false)') },
      annotations: WRITE_ONCE,
    }, write('marketing_refresh', async ({ all = false }) => api(`/marketing/enrich${all ? '?all=1' : ''}`, { method: 'POST', body: {} })));
  }

  // ── Grant clients and intake ──────────────────────────────────────────────

  // The list view leaves out what only a single client needs (the Documents-tab
  // list, applications, program options, notes) and keeps each contact to who
  // they are: name, email (inbound mail is matched to clients on it) and side.
  // client_get still returns all of it.
  const LIST_DROPS = ['documents', 'documents_customised', 'documents_received', 'applications', 'applications_set', 'programs', 'notes'];
  const listView = c => {
    if (!c || typeof c !== 'object') return c;
    const out = Object.fromEntries(Object.entries(c).filter(([k]) => !LIST_DROPS.includes(k)));
    if (Array.isArray(c.contacts)) out.contacts = c.contacts.map(({ name, email, side }) => ({ name, email, side }));
    return out;
  };

  server.registerTool('clients_list', {
    title: 'List grant clients',
    description: 'In-house NSGP grant-writing clients and where each stands: phase (1 sales, 2 grant writing, 3 compliance, 4 implementation), status, intake link, contacts (name, email, side), core questions answered and checklist tasks done vs total, who is filling the form in, last client save (the quiet clock), submission stamp. client_get has documents, applications and notes. Default status "active"; "all" for everyone.',
    inputSchema: {
      status: z.enum([...CLIENT_STATUSES, 'all']).optional().describe('Default "active"'),
      phase: z.number().int().min(1).max(4).optional(),
      search: z.string().optional().describe('Substring match on name or slug'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100)'),
    },
    annotations: READ,
  }, tool(async ({ status = 'active', phase, search = '', limit = 100 }) => {
    const params = new URLSearchParams({ status });
    if (phase) params.set('phase', String(phase));
    if (search) params.set('search', search);
    const rows = await api(`/clients?${params}`);
    return { count: rows.length, clients: rows.slice(0, limit).map(listView) };
  }));

  server.registerTool('client_get', {
    title: 'Get grant client',
    description: 'One grant client by slug: record, contacts, intake link, SAA, documents, applications, headline intake counts. Detail is in intake_status and intake_answers.',
    inputSchema: { slug: z.string().min(1).describe('Client slug from clients_list, e.g. "trinity-wellsprings-church"') },
    annotations: READ,
  }, tool(async ({ slug }) => api(`/clients/${encodeURIComponent(slug)}`)));

  server.registerTool('intake_questions', {
    title: 'Intake question catalog',
    description: 'The intake form\'s keys with section, label, order and kind (text, textarea, select, upload, meta). The source of truth for intake_seed: look keys up rather than guess (some checklist stems are truncated, e.g. "chk_who_information_collection_workbook_co"). Filter by exact section (e.g. "Checklist") or key prefix (e.g. "chk_status_", "wl_f1_", "prog1_").',
    inputSchema: {
      section: z.string().optional(),
      prefix: z.string().optional(),
    },
    annotations: READ,
  }, tool(async ({ section = '', prefix = '' }) => {
    const params = new URLSearchParams();
    if (section) params.set('section', section);
    if (prefix) params.set('prefix', prefix);
    const qs = params.toString();
    return api(`/intake/questions${qs ? `?${qs}` : ''}`);
  }));

  server.registerTool('intake_answers', {
    title: 'Intake answers',
    description: 'A client\'s intake answers in form order: section, question label, value, when and by whom last saved ("client:<name>" from the form, "seed:<key>" from a team seed, "import"). Empty questions are left out unless include_empty is true. Filter to a section to keep it small (the wish list alone is 363 keys).',
    inputSchema: {
      slug: z.string().min(1),
      section: z.string().optional().describe('Exact section name, e.g. "4. Threats", "Locations", "Wish List — Facility 1", "Checklist"'),
      include_empty: z.boolean().optional().describe('Include unanswered questions (default false)'),
    },
    annotations: READ,
  }, tool(async ({ slug, section = '', include_empty = false }) => {
    const params = new URLSearchParams();
    if (section) params.set('section', section);
    if (include_empty) params.set('include_empty', '1');
    const qs = params.toString();
    return api(`/clients/${encodeURIComponent(slug)}/answers${qs ? `?${qs}` : ''}`);
  }));

  server.registerTool('intake_status', {
    title: 'Intake status',
    description: 'Where a client\'s intake stands: answered vs total per section; wish list progress per facility (prioritised items, detail fields filled of five; truer than raw section counts), per application in wish_lists (wish_list = the first); checklist tasks with status, due date, owner, note (wish list, budget, IJ and submission tasks repeat per application, tagged application and application_label); who is filling it in; submission stamp; last client save; uploads. Check it before a nudge or drafting the IJ.',
    inputSchema: { slug: z.string().min(1) },
    annotations: READ,
  }, tool(async ({ slug }) => api(`/clients/${encodeURIComponent(slug)}/status`)));

  server.registerTool('intake_uploads_list', {
    title: 'Intake uploads',
    description: 'Files a client uploaded through the intake form: filename, type, size, when and by whom, the Drive link if mirrored to their Phase 2 folder, and the backend download path (needs a bearer key; MCP returns no file bytes).',
    inputSchema: { slug: z.string().min(1) },
    annotations: READ,
  }, tool(async ({ slug }) => api(`/clients/${encodeURIComponent(slug)}/uploads`)));

  if (canWrite) {
    server.registerTool('client_create', {
      title: 'Register grant client',
      description: 'WRITE. Confirm with the user before calling. Registers a new in-house grant-writing client and mints their intake link (intake_url, for the kickoff email). The slug comes from the name unless given; fails if taken. contacts: the client\'s people, the first is primary. npsa_contacts: NPSA people beyond Stuart and Brad (added automatically; include_team: false leaves them off), usually the consultant who brought the client in, role "Consultant". reference_contacts: left out, the state\'s verified SAA, program and CISA contacts from the knowledge base are added read-only; false for none; or a list instead. upload_folder_id (Drive Phase 2) can be set later.',
      inputSchema: {
        name: z.string().min(1).describe('Organization name as the client uses it'),
        state: z.string().length(2).describe('Two-letter state code'),
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(3).max(60).optional().describe('Override the derived slug'),
        contacts: contactList.optional(),
        npsa_contacts: contactList.optional(),
        include_team: z.boolean().optional().describe('Default true'),
        upload_folder_id: z.string().optional().describe('Drive Phase 2 folder id'),
        drive_folder_id: z.string().optional().describe('Drive client root folder id'),
        asana_project_gid: z.string().optional(),
        kickoff_date: z.string().regex(ISO_DATE).optional().describe('Day 0, YYYY-MM-DD'),
        program_track: z.string().optional().describe('e.g. "2026 federal NSGP + NSGP-IL"'),
        applications: z.array(applicationShape).optional().describe('One per program and cycle NPSA is writing; sets the form\'s budget caps and documents'),
        reference_contacts: z.union([z.literal(false), contactList]).optional(),
        notes: z.string().optional(),
      },
      annotations: WRITE_ONCE,
    }, write('client_create', async (args) => {
      const body = { ...args, state: normState(args.state) };
      return api('/clients', { method: 'POST', body });
    }));

    server.registerTool('client_update', {
      title: 'Update grant client',
      description: 'WRITE. Confirm with the user before calling. Changes a client; only the fields given change. status "submitted" stamps the submission time; "cancelled" or "closed" at closeout. add_contacts: the client\'s people; add_npsa_contacts: NPSA people (a consultant is role "Consultant"); add_reference_contacts: outside helpers shown read-only (SAA contact, CISA advisor); remove_contact_emails: any side. applications replaces the list (pass all, keeping ids; null clears). Documents tab (see client_get): documents replaces it, add_documents / remove_document_keys edit it, mark_ / unmark_documents_received record ones that came outside the form. client_invite emails a contact their link. Slug and token never change here (client_token_rotate).',
      inputSchema: {
        slug: z.string().min(1),
        name: z.string().min(1).optional(),
        state: z.string().length(2).optional(),
        phase: z.number().int().min(1).max(4).optional(),
        status: z.enum(CLIENT_STATUSES).optional(),
        program_track: z.string().optional(),
        drive_folder_id: z.string().optional(),
        upload_folder_id: z.string().optional(),
        asana_project_gid: z.string().optional(),
        kickoff_date: z.string().regex(ISO_DATE).optional(),
        notes: z.string().optional(),
        add_contacts: contactList.optional(),
        add_npsa_contacts: contactList.optional(),
        add_reference_contacts: contactList.optional(),
        remove_contact_emails: z.array(z.string().email()).optional(),
        applications: z.array(applicationShape).nullable().optional(),
        mark_documents_received: z.array(z.string()).optional().describe('Document keys'),
        unmark_documents_received: z.array(z.string()).optional(),
        documents: z.array(documentShape).nullable().optional().describe('null resets to the defaults for the state (Cal OES set when program_track names CSNSGP)'),
        add_documents: z.array(documentShape).optional(),
        remove_document_keys: z.array(z.string()).optional().describe('e.g. ["up_bios"]'),
      },
      annotations: WRITE,
    }, write('client_update', async ({ slug, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (body.state) body.state = normState(body.state);
      if (!Object.keys(body).length) throw new Error('Nothing to change: give at least one field to update');
      return api(`/clients/${encodeURIComponent(slug)}`, { method: 'PATCH', body });
    }));

    // Its own tool, not a client_update field: it sends an email to someone outside
    // NPSA, which is neither idempotent nor closed-world, and a client clicking a
    // client_update approval should not find it also mailed someone. The route is
    // the same PATCH the Grant Writing page's invite button uses.
    server.registerTool('client_invite', {
      title: 'Email a client their intake link',
      description: 'WRITE. Confirm with the user before calling, naming the person. Emails one of the client\'s own contacts their intake link, as their grant writer, the way sharing a Drive file does. Sends even if they were welcomed before. The address must already be one of the client\'s contacts (add it with client_update add_contacts); otherwise nothing is sent and invite.reason says why.',
      inputSchema: {
        slug: z.string().min(1),
        email: z.string().email(),
      },
      annotations: SENDS_EMAIL,
    }, write('client_invite', async ({ slug, email }) => {
      const r = await api(`/clients/${encodeURIComponent(slug)}`, { method: 'PATCH', body: { invite_contact_email: email } });
      return { slug: r?.slug ?? slug, email, invite: r?.invite ?? null };
    }));

    server.registerTool('intake_seed', {
      title: 'Seed intake answers',
      description: 'WRITE. Confirm with the user before calling. Writes intake answers: kickoff facts (legal name, EIN, contacts, website programs), checklist statuses, owners and due dates, NPSA notes, corrections. Every key must be in intake_questions, except that a later application keeps its wish list under wl_<application id>_f<n>_… (e.g. wl_a2_f1_vehicle_bollards_int, same questions as wl_f1_…). One unknown key fails the whole call, naming the keys; nothing is written. Values are text and overwrite. The client\'s "who is filling this out" and last activity are untouched. Website programs: prog<n>_… with prog<n>_suggested "Yes" (shown as suggested until the client confirms). NPSA notes: note_q_… keys, read-only under the answer; _note_asks (comma-separated question keys, e.g. "q_3_3_1,q_4_2") marks the ones that are questions for the client.',
      inputSchema: {
        slug: z.string().min(1),
        answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Intake key → value, e.g. {"q_1_3_1": "Trinity Wellsprings Church, Inc.", "chk_status_kickoff_call": "Completed"}'),
        by: z.string().optional().describe('Attribution label instead of "seed:<key>", e.g. "import:apps-script". Cannot start with "client".'),
      },
      annotations: WRITE,
    }, write('intake_seed', async ({ slug, answers, by }) => {
      if (!answers || !Object.keys(answers).length) throw new Error('Nothing to seed: answers is empty');
      return api(`/clients/${encodeURIComponent(slug)}/answers`, { method: 'PUT', body: { answers, ...(by ? { by } : {}) } });
    }));

    server.registerTool('client_token_rotate', {
      title: 'Re-issue intake link',
      description: 'WRITE, destructive. Confirm with the user before calling, naming the client. Mints a new token: the link they have stops working at once and the new intake_url must be sent to them. For a link that leaked or went to the wrong person. Answers are untouched.',
      inputSchema: { slug: z.string().min(1) },
      annotations: DESTRUCTIVE,
    }, write('client_token_rotate', async ({ slug }) => api(`/clients/${encodeURIComponent(slug)}/token`, { method: 'POST', body: {} })));

    server.registerTool('client_delete', {
      title: 'Delete grant client',
      description: 'WRITE, destructive and permanent. Confirm with the user before calling, naming the client. Deletes a client with every answer, upload and contact; no undo. Two steps: call without confirm to get what would be lost (nothing is deleted), show the user, and once they agree to that client call again with confirm set to the slug. An active client cannot be deleted (cancel or close it first). For demo and test records; close a finished engagement instead.',
      inputSchema: {
        slug: z.string().min(1),
        confirm: z.string().optional().describe('The slug again, on the second call only'),
      },
      annotations: DESTRUCTIVE,
    }, write('client_delete', async ({ slug, confirm }) => {
      const path = `/clients/${encodeURIComponent(slug)}${confirm ? `?confirm=${encodeURIComponent(confirm)}` : ''}`;
      return api(path, { method: 'DELETE' });
    }));
  }

  return server;
}

// ── Express wiring ────────────────────────────────────────────────────────────

export function registerMcp(app, { port, internalKey }) {
  const base = () => `http://127.0.0.1:${typeof port === 'function' ? port() : port}/api`;

  // The grant-client routes are keyed. Loopback calls get in with the key this
  // process minted at boot, plus the caller's name or fingerprint so the route's
  // own log line names the same actor the MCP audit line does.
  async function api(path, { method = 'GET', body, actor } = {}) {
    const r = await fetch(`${base()}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(internalKey ? { 'X-Internal-Key': internalKey, 'X-Actor': actor || 'mcp' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      const isObj = data && typeof data === 'object' && !Array.isArray(data);
      const msg = isObj && data.error ? data.error : `HTTP ${r.status} from ${path}`;
      const err = new Error(msg);
      // The rest of the body (a 409's current or existing record, a refused seed's
      // unknown_keys, a delete's confirm_required) travels with the error.
      if (isObj) {
        const { error, ...rest } = data;
        if (Object.keys(rest).length) err.details = rest;
      }
      err.status = r.status;
      throw err;
    }
    return data;
  }

  app.post(MCP_PATH, requireMcpKey, async (req, res) => {
    const { actor } = req.mcp;
    const server = buildMcpServer({ api: (path, opts) => api(path, { ...opts, actor }), canWrite: req.mcp.canWrite, actor });
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
