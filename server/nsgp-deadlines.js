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

/*
 * The rows used to be seeded from nsgp-data.json (an extraction of the Drive YAML)
 * with a web-check overlay in nsgp-verified.json. The grant knowledge base holds all
 * of that now, and serves it in this table's shape (server/gk-deadlines.js); the
 * table stays only as the fallback that adapter reads if the knowledge base cannot
 * be, and is no longer written.
 */

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
    ALTER TABLE nsgp_deadlines ADD COLUMN IF NOT EXISTS layer TEXT DEFAULT 'manual';
  `).catch(err => console.error('nsgp_deadlines schema error:', err.message));
}

/** Every row, newest cycle first — the editor's list. */
export async function listDeadlines(pool) {
  const { rows } = await pool.query(
    `SELECT id, state, program, cycle_year, to_char(deadline,'YYYY-MM-DD') AS deadline,
            kind, note, source, confidence, layer, updated_at
       FROM nsgp_deadlines ORDER BY state, program, cycle_year DESC`);
  return rows;
}

/**
 * Rows relevant to one state: its own sub-applicant deadlines, plus the federal
 * FEMA-level dates (state 'US') as a backstop for states with nothing recorded.
 */
export async function deadlinesForState(pool, state) {
  const st = String(state || '').trim().toUpperCase();
  if (!st) return [];
  const { rows } = await pool.query(
    `SELECT state, program, cycle_year, to_char(deadline,'YYYY-MM-DD') AS deadline, kind, note, source, confidence, layer
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

const ZONE = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET', 'America/Kentucky/Louisville': 'ET',
  'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Boise': 'MT', 'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT', 'America/Puerto_Rico': 'AST', 'America/St_Thomas': 'AST',
  'Pacific/Guam': 'ChST', 'Pacific/Saipan': 'ChST', 'Pacific/Pago_Pago': 'SST',
};

/** "July 1, 2026, 11:59 PM AKT", or just the date when no time was recorded. */
function when(r) {
  const day = pretty(r.deadline);
  if (!r.due_time) return day;
  const [h, m] = r.due_time.split(':').map(Number);
  const zone = r.tz ? ZONE[r.tz] || r.tz.split('/').pop().replace(/_/g, ' ') : '';
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}${zone ? ` ${zone}` : ''}`;
}

// A stage label worth saying. "Application due" on a one-stage cycle says nothing
// the date does not, so a plain cycle reads exactly as it always did.
const GENERIC = /^(application|applications?|final)( due| deadline)?$/i;

/**
 * Projects the next window from recorded history: the month these deadlines have
 * actually landed in. Returns null with fewer than two recorded cycles, because one
 * data point is not a pattern and saying so is the whole point of this rewrite.
 * One row per cycle: a staged cycle projects from its first stage, the one a
 * client has to be ready for.
 */
function project(rows, todayIso) {
  const firstOf = new Map();
  for (const r of rows.filter(r => r.deadline)) {
    const f = firstOf.get(r.cycle_year);
    if (!f || r.deadline < f.deadline) firstOf.set(r.cycle_year, r);
  }
  const dated = [...firstOf.values()].sort((a, b) => b.cycle_year - a.cycle_year);
  if (dated.length < 2) return null;
  const months = dated.slice(0, 3).map(r => +r.deadline.slice(5, 7));
  const modal = months.sort((a, b) =>
    months.filter(x => x === b).length - months.filter(x => x === a).length)[0];
  const latest = [...rows.filter(r => r.cycle_year === dated[0].cycle_year && r.deadline)].sort((a, b) => b.deadline.localeCompare(a.deadline))[0];
  // Only project past the most recent recorded cycle, and only once it has passed.
  const nextYear = latest.deadline < todayIso ? latest.cycle_year + 1 : null;
  if (!nextYear) return null;
  return `~${MONTHS[modal - 1]} ${nextYear} (projected from ${dated.length} recorded cycle${dated.length === 1 ? '' : 's'})`;
}

/**
 * The deadline section, rendered by code. Given the rows and the moment, this is
 * deterministic: the same table produces the same section every time, which is
 * what "curated" has to mean if it is going to be worth curating.
 *
 * Rows from the knowledge base can carry more than the old table did: several
 * stages in one cycle (Texas certifies in February and submits in July), a time of
 * day and a time zone. A cycle lists its stages in order; "next" is the first
 * stage still ahead at `now`, measured against its own clock, so a 5:00 PM Central
 * deadline is still open at 4:59 in Austin; and the stages after it follow, since
 * a rep who only hears about the first one has been told half of it. Rows with none
 * of that (the old table, if the knowledge base is ever unreadable) render as they
 * always have.
 */
export function renderDeadlines(rows, { state, saaName, todayIso, now }) {
  const st = String(state || '').toUpperCase();
  const at = now instanceof Date ? now.getTime() : null;
  const ahead = r => (at !== null && r.instant ? Date.parse(r.instant) > at : r.deadline >= todayIso);
  const label = r => (r.stage_label && !GENERIC.test(r.stage_label.trim()) ? `${r.stage_label} by ` : '');
  const byStage = (a, b) => (a.stage_order ?? 1) - (b.stage_order ?? 1) || a.deadline.localeCompare(b.deadline);
  const sure = r => (r.confidence === 'illustrative' ? 'recorded — confirm before relying on it' : 'confirmed');
  const cycles = list => [...new Set(list.map(r => r.cycle_year))].sort((a, b) => b - a);
  // The FEMA line says what its dates are in its own words, so its rows go unlabelled.
  const cycleLine = (list, year, stageMarks) => `FY${year} — ` + list.filter(r => r.cycle_year === year).sort(byStage)
    .map(r => `${stageMarks ? label(r) : ''}${pretty(r.deadline)}${stageMarks && ahead(r) ? ' (open)' : ''}`).join(', then ');
  const nextLine = (list, lead) => {
    const open = list.filter(ahead).sort((a, b) => (a.instant && b.instant ? a.instant.localeCompare(b.instant) : a.deadline.localeCompare(b.deadline)));
    if (!open.length) return null;
    const [first, ...rest] = open;
    const then = rest.filter(r => r.cycle_year === first.cycle_year);
    return `${lead} **${label(first)}${when(first)}** (FY${first.cycle_year}, ${sure(first)}).` +
      (first.note ? ` ${first.note}` : '') +
      (then.length ? ` Then: ${then.map(r => `${label(r)}${when(r)}`).join('; ')}.` : '');
  };

  const sub = rows.filter(r => r.state === st && (r.program === 'federal' || r.program === 'federal-noi') && r.deadline);
  const fema = rows.filter(r => r.state === 'US' && r.program === 'federal' && r.deadline);
  const out = [];

  const recent = cycles(sub).slice(0, 3);
  if (recent.length) {
    out.push(`Recorded ${st} sub-applicant deadlines: ` + recent.map(y => cycleLine(sub, y, true)).join('; ') + '.');
    const next = nextLine(sub.filter(r => recent.includes(r.cycle_year)), 'Next deadline:');
    if (next) out.push(next);
    else {
      const p = project(sub, todayIso);
      out.push(p
        ? `The FY${recent[0]} window has closed. Next window: ${p} — confirm with ${saaName || 'the SAA'}.`
        : `The FY${recent[0]} window has closed and the next cycle is not yet recorded — confirm with ${saaName || 'the SAA'}.`);
    }
  } else {
    out.push(`No ${st} sub-applicant deadlines are recorded yet — confirm with ${saaName || 'the SAA'}. ` +
      `(Add them in the Grant Knowledge tab so they appear here next time.)`);
  }

  const femaYears = cycles(fema).slice(0, 3);
  if (femaYears.length) {
    out.push(`Federal (FEMA-to-SAA) dates on record: ` + femaYears.map(y => cycleLine(fema, y, false)).join('; ') +
      `. Sub-applicant deadlines are earlier than these.`);
  }

  // States running their own program keep its dates under the program's acronym
  // rather than 'federal', so each renders as a separate track.
  for (const prog of [...new Set(rows.filter(r => r.state === st && r.program !== 'federal' && r.program !== 'federal-noi').map(r => r.program))]) {
    const pr = rows.filter(r => r.state === st && r.program === prog && r.deadline);
    const years = cycles(pr).slice(0, 3);
    if (!years.length) continue;
    const next = nextLine(pr.filter(r => years.includes(r.cycle_year)), 'Next:');
    out.push(`**${prog}:** ` + years.map(y => cycleLine(pr, y, true)).join('; ') + '.' +
      (next ? ` ${next}` : ' Next cycle not yet recorded.'));
  }

  return out.map(l => `- ${l}`).join('\n');
}

export const __test = { project, pretty, renderDeadlines };
