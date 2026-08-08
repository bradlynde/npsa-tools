/*
 * Curated NSGP deadlines.
 *
 * These used to be produced by throwing a web search at a language model and
 * asking it to pick dates out of the results. Brad's report on the City Church
 * notes was that the section was inaccurate and, worse, not worth much: Indiana
 * had published its FY2026 sub-applicant deadline and the notes still said TBD.
 *
 * A deadline is a small, slow-moving, high-consequence fact. There are ~50 of them
 * a year and they change once. That is a table someone maintains, not something to
 * re-derive from search results on every call — so this is a table, stored in the
 * database, edited in the tool, and rendered into the notes by code rather than by
 * the model.
 *
 * Nothing here is inferred. A cycle with no recorded date renders as "not recorded"
 * and points the rep at the SAA. It never guesses, and it never projects a date as
 * though it were published — projections are labelled as projections and are
 * computed from recorded history, so a projection with no history simply does not
 * appear.
 */

import { readFileSync } from 'fs';

/*
 * The seed comes from NPSA's own grant-knowledge base rather than from this file.
 *
 * server/nsgp-data.json is extracted from the states/*.yaml set in the shared
 * Drive folder — the set the team already maintains, with its own last_verified
 * dates and source URLs per state. Transcribing 51 jurisdictions by hand into a
 * second list would create a rival source of truth that goes stale the first time
 * someone updates Drive and not this repo, so the extraction is kept mechanical
 * and the provenance travels with each row.
 *
 * `confidence` matters and is not cosmetic. The knowledge base distinguishes a
 * date it states plainly from one it flags "verify each cycle" or records as a
 * note about a window that has already closed. Presenting the second kind as
 * confirmed is precisely the failure this whole table replaced.
 */
const KB = JSON.parse(
  readFileSync(new URL('./nsgp-data.json', import.meta.url), 'utf8'),
);

const SEED = [
  // The one row with no state file behind it: FEMA's own deadline for SAAs, which
  // bounds every sub-applicant deadline from above.
  { state: 'US', program: 'federal', cycleYear: 2026, deadline: '2026-07-24', kind: 'fema',
    confidence: 'confirmed',
    note: 'FEMA deadline for State Administering Agencies. Sub-applicant deadlines are earlier and set per state.',
    source: 'fema.gov/grants/preparedness/nonprofit-security' },

  ...Object.entries(KB.states).flatMap(([state, s]) =>
    (s.deadlines || [])
      .filter((d) => d.date)
      .map((d) => ({
        state,
        program: d.program,
        cycleYear: d.cycle,
        deadline: d.date,
        kind: d.program === 'federal' ? 'sub_applicant' : 'state_program',
        confidence: d.confidence || 'illustrative',
        note: d.note || '',
        source: d.source || '',
      })),
  ),
];

/** SAA name per state, from the knowledge base rather than from memory. */
export const SAA_BY_STATE = Object.fromEntries(
  Object.entries(KB.states).map(([state, s]) => [state, s.saa]).filter(([, v]) => v),
);

/** State-funded programs that stack with (or substitute for) federal NSGP. */
export const STATE_PROGRAMS_BY_STATE = Object.fromEntries(
  Object.entries(KB.states)
    .filter(([, s]) => (s.state_programs || []).length)
    .map(([state, s]) => [state, s.state_programs]),
);

export async function ensureDeadlineSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nsgp_deadlines (
      id          SERIAL PRIMARY KEY,
      state       TEXT NOT NULL,
      program     TEXT NOT NULL DEFAULT 'federal',
      cycle_year  INT  NOT NULL,
      deadline    DATE,
      kind        TEXT NOT NULL DEFAULT 'sub_applicant',
      note        TEXT DEFAULT '',
      source      TEXT DEFAULT '',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (state, program, cycle_year)
    );
    ALTER TABLE nsgp_deadlines ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'confirmed';
  `).catch(err => console.error('nsgp_deadlines schema error:', err.message));

  // Seed once. ON CONFLICT DO NOTHING means an edited row is never overwritten by a
  // redeploy — the table belongs to whoever maintains it, not to this file.
  for (const d of SEED) {
    await pool.query(
      `INSERT INTO nsgp_deadlines (state, program, cycle_year, deadline, kind, note, source, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (state, program, cycle_year) DO NOTHING`,
      [d.state, d.program, d.cycleYear, d.deadline, d.kind, d.note, d.source, d.confidence],
    ).catch(err => console.error('nsgp_deadlines seed error:', err.message));
  }
}

/** Every row, newest cycle first — the editor's list. */
export async function listDeadlines(pool) {
  const { rows } = await pool.query(
    `SELECT id, state, program, cycle_year, to_char(deadline,'YYYY-MM-DD') AS deadline,
            kind, note, source, confidence, updated_at
       FROM nsgp_deadlines ORDER BY state, program, cycle_year DESC`);
  return rows;
}

export async function upsertDeadline(pool, d) {
  const state = String(d.state || '').trim().toUpperCase();
  const program = String(d.program || 'federal').trim();
  const cycleYear = parseInt(d.cycleYear ?? d.cycle_year, 10);
  if (!state) throw new Error('state is required');
  if (!Number.isInteger(cycleYear)) throw new Error('cycleYear must be a year');
  const deadline = d.deadline ? String(d.deadline).slice(0, 10) : null;
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new Error('deadline must be YYYY-MM-DD');

  const { rows } = await pool.query(
    `INSERT INTO nsgp_deadlines (state, program, cycle_year, deadline, kind, note, source, confidence, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (state, program, cycle_year) DO UPDATE SET
       deadline = EXCLUDED.deadline, kind = EXCLUDED.kind, note = EXCLUDED.note,
       source = EXCLUDED.source, confidence = EXCLUDED.confidence, updated_at = NOW()
     RETURNING id`,
    [state, program, cycleYear, deadline, d.kind || 'sub_applicant', d.note || '', d.source || '',
     d.confidence === 'illustrative' ? 'illustrative' : 'confirmed']);
  return rows[0].id;
}

export async function deleteDeadline(pool, id) {
  await pool.query('DELETE FROM nsgp_deadlines WHERE id=$1', [id]);
}

/**
 * Rows relevant to one state: its own sub-applicant deadlines, plus the federal
 * FEMA-level dates (state 'US') as a backstop for states with nothing recorded.
 */
export async function deadlinesForState(pool, state) {
  const st = String(state || '').trim().toUpperCase();
  if (!st) return [];
  const { rows } = await pool.query(
    `SELECT state, program, cycle_year, to_char(deadline,'YYYY-MM-DD') AS deadline, kind, note, source, confidence
       FROM nsgp_deadlines WHERE state = $1 OR state = 'US'
      ORDER BY cycle_year DESC`, [st]);
  return rows;
}

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December'];

/** "July 9, 2026" from an ISO date, without going through Date (no timezone shift). */
function pretty(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/**
 * Projects the next window from recorded history: the month these deadlines have
 * actually landed in. Returns null with fewer than two recorded cycles, because one
 * data point is not a pattern and saying so is the whole point of this rewrite.
 */
function project(rows, todayIso) {
  const dated = rows.filter(r => r.deadline).sort((a, b) => b.cycle_year - a.cycle_year);
  if (dated.length < 2) return null;
  const months = dated.slice(0, 3).map(r => +r.deadline.slice(5, 7));
  const modal = months.sort((a, b) =>
    months.filter(x => x === b).length - months.filter(x => x === a).length)[0];
  const latest = dated[0];
  // Only project past the most recent recorded cycle, and only once it has passed.
  const nextYear = latest.deadline < todayIso ? latest.cycle_year + 1 : null;
  if (!nextYear) return null;
  return `~${MONTHS[modal - 1]} ${nextYear} (projected from ${dated.length} recorded cycle${dated.length === 1 ? '' : 's'})`;
}

/**
 * The deadline section, rendered by code. Given the rows and today's date, this is
 * deterministic — the same table produces the same section every time, which is
 * what "curated" has to mean if it is going to be worth curating.
 */
export function renderDeadlines(rows, { state, saaName, todayIso }) {
  const st = String(state || '').toUpperCase();
  const sub = rows.filter(r => r.state === st && r.program === 'federal');
  const fema = rows.filter(r => r.state === 'US' && r.program === 'federal');
  const out = [];

  const history = sub.filter(r => r.deadline).slice(0, 3);
  if (history.length) {
    out.push(`Recorded ${st} sub-applicant deadlines: ` + history
      .map(r => `FY${r.cycle_year} — ${pretty(r.deadline)}${r.deadline >= todayIso ? ' (open)' : ''}`)
      .join('; ') + '.');
    const open = history.find(r => r.deadline >= todayIso);
    if (open) {
      // "confirmed" is claimed only where the source states the date plainly. A row
      // the knowledge base itself flags "verify each cycle" is a date worth acting
      // on but not worth promising, and a rep should be able to see which they have.
      out.push(`Next deadline: **${pretty(open.deadline)}** (FY${open.cycle_year}, ` +
        `${open.confidence === 'illustrative' ? 'recorded — confirm before relying on it' : 'confirmed'}).` +
        (open.note ? ` ${open.note}` : ''));
    } else {
      const p = project(sub, todayIso);
      out.push(p
        ? `The FY${history[0].cycle_year} window has closed. Next window: ${p} — confirm with ${saaName || 'the SAA'}.`
        : `The FY${history[0].cycle_year} window has closed and the next cycle is not yet recorded — confirm with ${saaName || 'the SAA'}.`);
    }
  } else {
    out.push(`No ${st} sub-applicant deadlines are recorded yet — confirm with ${saaName || 'the SAA'}. ` +
      `(Add them under Deadlines so they appear here next time.)`);
  }

  const femaOpen = fema.filter(r => r.deadline).slice(0, 3);
  if (femaOpen.length) {
    out.push(`Federal (FEMA-to-SAA) dates on record: ` + femaOpen
      .map(r => `FY${r.cycle_year} — ${pretty(r.deadline)}`).join('; ') +
      `. Sub-applicant deadlines are earlier than these.`);
  }

  // States running their own stackable program keep their dates under the program
  // acronym rather than 'federal', so they render as a separate track.
  for (const prog of [...new Set(rows.filter(r => r.state === st && r.program !== 'federal').map(r => r.program))]) {
    const pr = rows.filter(r => r.state === st && r.program === prog && r.deadline).slice(0, 3);
    if (!pr.length) continue;
    const open = pr.find(r => r.deadline >= todayIso);
    out.push(`**${prog}:** ` + pr.map(r => `FY${r.cycle_year} — ${pretty(r.deadline)}`).join('; ') +
      (open
        ? `. Next: **${pretty(open.deadline)}** (${open.confidence === 'illustrative' ? 'recorded — confirm' : 'confirmed'}).`
          + (open.note ? ` ${open.note}` : '')
        : `. Next cycle not yet recorded.`));
  }

  return out.map(l => `- ${l}`).join('\n');
}

export const __test = { project, pretty, renderDeadlines, SEED };
