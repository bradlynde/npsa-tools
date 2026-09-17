# Grant knowledge

What NPSA knows about NSGP and the state-funded programs, per jurisdiction: who
administers it, what a submission needs, when it opened and closed each year and for
how much, who to call, and what has gone wrong before. The team edits it in the
toolbox, Claude reads and writes it through the MCP, and the grant-clients module and
the pre-call briefing will read from it instead of from files.

It replaces a Drive folder of YAML (`Operations/grant-knowledge/`) and, in stages, the
three extractions of that folder this repo carries: `nsgp-data.json` with
`nsgp-verified.json`, `intake-state-config.json` and `intake-documents.json`. Those
files stay in use until the PR that repoints each consumer; nothing here touches them.

## The build, in order

| PR | What |
| :-- | :-- |
| B1 | Identity: `MCP_KEY_NAMES`, `ACTOR_PROXY_KEYS` (see [mcp.md](mcp.md)) |
| **B2** | **This module: tables, stores, routes, `scripts/gk-smoke.mjs`** |
| B3 | Import from the Drive YAML, with a conflict report to rule on; `/import`, `/export` |
| B4 | MCP tools (`gk_*`), and `nsgp_state_reference` read from here |
| F1, F2 | The Grant Knowledge tab on `frontend`: map, state page, then editing, history, the queue |
| B5 / F3 | File attachments (NOFOs, state guidance) |
| B6 | `nsgp_deadlines` served from here behind its existing shape |
| B7 | Intake reads from here: registration steps, documents, caps, reference contacts |
| B8 | Pre-call briefing reads from here; the JSON files go |
| F4 / B9 | The old deadline card and editor go |

## Model

Two tables, created on boot like the rest (`ensureGrantKnowledgeSchema`).

`gk_records` is one row per record. `jurisdiction` is a USPS code, `DC`, a territory
(`PR GU VI AS MP`) or `US` for what is true nationally. `kind` is one of:

| Kind | Hangs under | Holds |
| :-- | :-- | :-- |
| `jurisdiction` | nothing | SAA, short name, urban areas, partner, default time zone, cycle status. On `US`: the IJ form block |
| `program` | nothing | federal or state, administering agency, status (`active dormant unconfirmed dead`), caps, M&A, match, period of performance, stackable, `exclusive_with`, `inherits_from`, submission method and portal, file naming |
| `requirement` | a program | a registration step or a required document: owner (`client` or `npsa`), lead time, hard gate, format, phase, and the intake page's wording and upload key |
| `cycle` | a program | one fiscal year: status, NOFO and open dates, funding, allocations, applications and awards |
| `deadline` | a cycle | one stage: label, date, time, IANA zone, kind, confidence. Texas's two stages are two rows |
| `contact` | nothing, or a program | name, role, org, email, phone, kind (`saa program cisa_psa partner helpdesk other`), last confirmed, warning |
| `note` | nothing, or a program | category (`gotcha eligibility scoring prohibited_cost post_award watch_item history process open_question`), severity up to `auto_disqualifier`, markdown body, phase, originating client |
| `source` | nothing, or a program | a URL and what it covers |

Each kind's fields are a strict zod schema in `server/grant-knowledge-kinds.js`. A write
with a field the schema does not know is refused by name. Facts with no field go in
`extra`; a remark about one field's value goes in `field_notes`.

The federal baseline is the requirements of the `US` program. A federal program in a
state shows those first, flagged `baseline: federal`, then its own, flagged `state`. A
state requirement with the same key as a baseline one (`ij`, `sam_uei`) stands in for
that line rather than appearing beside it: it is the baseline line as that state runs
it. A program with `inherits_from` (NSGP-UA from NSGP-S) shows its sibling's as well.

`gk_revisions` is append-only: one row per write, with full `before` and `after`
snapshots, the fields that changed, the actor, the actor kind (`user` from the toolbox,
`mcp` through Claude, `key` for a direct call), and an optional reason. The stores have
exactly two writes, `createRecord` and `updateRecord`, and both write the revision in
the same transaction, so there is no path that changes a record without one.

## Trust

- A new record is `unverified`. A person verifies it (`POST …/verify`, or `verify: true`
  on their own save).
- Editing a verified record keeps it verified and adds the fields that moved to
  `unverified_fields`. Verifying again clears them.
- `stale` is never stored. A verified record reads as `effective_status: stale` once the
  verification is more than 365 days old, except a deadline that has passed or a cycle
  that closed: what happened does not go stale.
- A write through Claude needs a `source_url`, or a `reason` saying the user stated it
  from direct experience. It cannot verify inline, and `origin` is `mcp` or `research`.
  A caller cannot claim an origin that is not theirs.
- Consumers that reach a client (the intake page, auto-seeded reference contacts, from
  B7) will read verified records only.

## Concurrency

Every write carries the `version` it was made against. If the record has moved on, the
answer is `409` with `current`, the record as it now stands, and who last edited it. The
store repeats the check atomically (`UPDATE … WHERE id = $1 AND version = $2`).

## Routes

All under `/api/grant-knowledge`, all behind the team gate (a bearer from `MCP_API_KEYS`,
or the internal key). `GET`, `POST` and `PATCH` only, which is what the Vercel proxy
forwards; removal is archive, and archive is reversible.

| Route | |
| :-- | :-- |
| `GET /overview` | one row per jurisdiction, always 57: SAA, programs, cycle state (`open soon closed unknown`), next deadline, freshness counts |
| `GET /jurisdictions/:code` | the assembled document. `?include_archived=1` adds `archived` |
| `GET /jurisdictions/:code/requirements?program=` | the merged checklist, hard gates and long lead times first |
| `GET /jurisdictions/:code/revisions`, `GET /revisions`, `GET /records/:id/revisions` | history, newest first, `?limit=&before=` |
| `GET /records/:id` | one record |
| `GET /search?q=&kinds=&state=` | every term must match |
| `GET /needs-attention?days=45&state=` | unverified, stale, deadlines soon, open questions, and what is missing |
| `POST /records` | `{ jurisdiction, kind, parent_id?, key?, data, source_url?, reason?, verify? }` |
| `PATCH /records/:id` | `{ version, data?, key?, source_url?, sort_order?, reason?, verify? }`; in `data`, `null` clears a field |
| `POST /records/:id/verify` `unverify` `archive` `restore` | `{ version }` |
| `POST /jurisdictions/:code/verify-bulk` | `{ ids: [{ id, version }] }`, reported per record |
| `POST /revisions/:id/revert` | `{ version }`; puts the record back to before that revision, as a new revision. Reverting a create archives |

A deadline's instant is its date and time in its own zone (the jurisdiction's
`default_tz` when the deadline names none; end of day when it names no time), so "open"
and "in 3 days" are right at the edges: 4:00 PM in Baton Rouge is still ahead at 3:59.

## Checks

`node scripts/gk-smoke.mjs` runs the routes against the in-memory store with an injected
clock: no database, no network. Run it under Node 18 as well
(`npx -p node@18 node scripts/gk-smoke.mjs`), which is what Railway runs.
