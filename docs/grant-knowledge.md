# Grant knowledge

What NPSA knows about NSGP and the state-funded programs, per jurisdiction: who
administers it, what a submission needs, when it opened and closed each year and for
how much, who to call, and what has gone wrong before. The team edits it in the
toolbox, Claude reads and writes it through the MCP, and the grant-clients module and
the pre-call briefing read from it instead of from files.

It replaces a Drive folder of YAML (`Operations/grant-knowledge/`) and the three
extractions of that folder this repo used to carry (`nsgp-data.json` with
`nsgp-verified.json`, `intake-state-config.json`, `intake-documents.json`), which B8
deleted. The client pages, the pre-call briefing, the deadline feed and the MCP all
read the knowledge base now; `server/grant-knowledge-seed.json`, the bundle it was
first loaded from, answers only while it cannot be read.

## The build, in order

| PR | What |
| :-- | :-- |
| B1 | Identity: `MCP_KEY_NAMES`, `ACTOR_PROXY_KEYS` (see [mcp.md](mcp.md)) |
| B2 | This module: tables, stores, routes, `scripts/gk-smoke.mjs` |
| B3 | Import from the Drive YAML, with a conflict report to rule on; `/import`, `/export` |
| B4 | MCP tools (`gk_*`), and `nsgp_state_reference` read from here |
| F1, F2 | The Grant Knowledge tab on `frontend`: map, state page, then editing, history, the queue |
| B5 / F3 | File attachments (NOFOs, state guidance) |
| B6 | `nsgp_deadlines` served from here behind its existing shape |
| B7 | Intake reads from here: registration steps, documents, caps, reference contacts |
| **B8** | **Pre-call briefing reads from here; the JSON files go** |
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
| `POST /files/ticket` | `{ jurisdiction, record_id?, label?, source_url? }` -> a signed ticket and the address to post to |
| `POST /files/upload` | multipart, `X-GK-Ticket` instead of the team key. Not on the toolbox proxy |
| `GET /files?jurisdiction=&record_id=&include_archived=` | what is attached, newest first, each with a download link |
| `GET /files/:id` | one file; `GET /files/:id/content?t=` serves the bytes on a download ticket |
| `POST /files/:id/archive` `restore` | no body |

| `POST /import` | `{ records, dry_run? }`, a bundle. Not on the toolbox proxy |
| `GET /export` | the same bundle format, from what is stored. Not on the toolbox proxy |

## Attachments

A NOFO, an SAA's own checklist, a screenshot of the step in the portal nobody can find:
`gk_files` holds them, hung on a jurisdiction and optionally on one record. Postgres
keeps the bytes; with `GK_DRIVE_FOLDER_ID` set, each one is also pushed to that Drive
folder, best effort, named `<CODE> <filename>` since one folder holds them all.

They do not travel through the Vercel passthrough, whose functions stop at 4.5 MB.
The browser asks `POST /files/ticket` through the proxy and gets back a short-lived
signed ticket naming the jurisdiction, the record and the person who asked, plus the
address to post to. It then posts the file straight here with the ticket in
`X-GK-Ticket`. So the team key never reaches the browser, and `uploaded_by` is the name
the gate resolved when the ticket was cut, not one the page could type. Downloads work
the same way in reverse (`?t=`), so a 20 MB PDF does not have to fit back through a
serverless response either.

The file's own first bytes decide its type: PDF, PNG, JPG, and Word or Excel, the last
two recognised by the package manifest inside rather than by the extension. Anything
else is refused. The same bytes posted twice hand back the file that is already there.
Content goes out with `nosniff`, which together with those five types is what keeps this
origin safe: none of them is a document the browser will run. A `sandbox` CSP would be
the belt and braces, but it also stops Chrome's PDF viewer, which turns opening a NOFO
into a file to save.

| Variable | |
| :-- | :-- |
| `GK_DRIVE_FOLDER_ID` | Drive folder for the mirror. Unset means Postgres only |
| `GK_APP_ORIGINS` | origins the upload route answers CORS for. Defaults to the production tab plus localhost; add a preview deployment's hostname here |
| `GK_UPLOAD_BASE` | this service's public address, when it should not be taken from the request |

A deadline's instant is its date and time in its own zone (the jurisdiction's
`default_tz` when the deadline names none; end of day when it names no time), so "open"
and "in 3 days" are right at the edges: 4:00 PM in Baton Rouge is still ahead at 3:59.

## Deadlines for the rest of the toolbox

The pre-call briefing, the toolbox's deadline panel and `nsgp_deadlines_list` used to read
the `nsgp_deadlines` table. They read the knowledge base now, through
`server/gk-deadlines.js`, which hands back rows in that table's shape (`state`, `program`,
`cycle_year`, `deadline`, `kind`, `note`, `source`, `confidence`, `layer`) with what the
table could not hold added alongside: `stage_label`, `stage_order`, `due_time`, `tz`,
`instant`, `record_id`, `program_key(s)`. `program` is `federal` for NSGP-S and NSGP-UA
(one row when both carry the same date), `federal-noi` for a notice of intent, the
acronym for a state program.

A row reads `confirmed` only when the source stated the date plainly and a person has
verified the record with the date as it now stands; anything else is `illustrative`,
which the briefing renders as "recorded, confirm before relying on it".

The briefing's section lists a staged cycle's stages in order and measures "next" on
each deadline's own clock, then names the stages after it. If the knowledge base cannot
be read, or holds no deadlines, the old table answers instead (`source: 'legacy-table'`
on `GET /api/precall/deadlines`). The old table is otherwise frozen: `PUT` and `DELETE`
on `/api/precall/deadlines` answer 410 and point here, since an edit there would be
accepted and then never seen.

`node scripts/gk-deadlines-smoke.mjs` covers the adapter, the fallback and the section.

## The client intake pages

The grant-clients module reads its per-state facts from here through `server/knowledge.js`:
the SAA, the registration steps on the page's checklist, the upload rows on the Documents
tab, the federal and state caps its budget checks against, the programs an application may
name, and the reference contacts a new client starts with. These reach clients, so only
**verified** records count. A verified record whose field changed and has not been
confirmed keeps its other fields; that one reads as unknown (a cap nobody has confirmed
shows as "not published"). Anything under an unverified parent drops with it.

- **Uploads.** The US program's document requirements that carry an `upload_key`, each in
  the state's own wording where the state has the same requirement, then the state's own
  additions. A state program with upload rows of its own (California's CSNSGP) replaces
  that list for a client applying to it (by application, or by `program_track` naming the
  program before applications are set). A list the team set on the client still wins.
- **Registration.** The federal programs' steps for every client, hard gates and the
  longest lead times first; a state program's steps only for a client applying to it.
  A requirement's `client_label` is what the client reads, `client_hint` pre-fills the note.
- **Caps.** The federal per-site cap is the state's own where it sets a lower one (Kansas,
  $150,000), else the NOFO's; the page's budget uses it. A site marked "State Program" draws
  on every live state program, but of a set the state awards only one of
  (`exclusive_with`: New Jersey's THE or SP) only the largest counts. Dormant programs are
  left out; an application can still name one, for a past round.
- **Reference contacts.** `POST /api/clients` adds up to four verified SAA, program and
  CISA contacts with an email (none carrying a `warning`), primary first, to the Contacts
  tab as reference rows. `reference_contacts: false` adds none; a list replaces them.

The pre-call briefing's funding block reads the same snapshot (`briefingFor`): the SAA's
full name, the state's federal per-site cap, and each state program's cap, stackability,
exclusivity, dormancy and note (`server/precall-state.js` writes the block). A program
administered by someone other than the SAA says so.

The snapshot loads at boot, refreshes every minute, and refreshes after every successful
write to `/api/grant-knowledge`, so an edit reaches client pages and briefings at once.
Until it has loaded, or if the knowledge base is empty or unreadable, the seed bundle
answers (projected the same way, verified records only). The same seed stands in for
`nsgp_state_reference` and the deadline feed's reference when the database is down.

`node scripts/intake-knowledge-smoke.mjs` covers the projection, the create, the seed
fallback and the briefing block.

## Through Claude

Eight read tools and four write tools on the MCP (`gk_*`, listed in [mcp.md](mcp.md)).
One upsert covers every kind: it finds the parent by key (`program`, then `cycle` for a
deadline), creates the record or, given the current `version`, changes it. Its description
carries the field list for each kind, generated from the schemas, so it cannot drift from
them. `gk_state_brief` is the jurisdiction as markdown (`GET /jurisdictions/:code?format=markdown`),
with what ends an application first and every unverified fact marked inline.

`GET /reference` serves the shape `nsgp_state_reference` has always returned, from the
knowledge base, so skills that parse it keep working; territories are now covered.

`gk_files_list` says what is attached to a jurisdiction. Files are put there from the
toolbox, not from here, and the listing leaves out the toolbox's own download links,
which are cut for one browser and expire in minutes; a Drive link, when there is one,
stays.

## Import from Drive

`scripts/gk-extract.mjs` reads the Drive folder (`_FEDERAL.yaml`, the 56 `states/XX.yaml`
with their comments, the seven prose companions), folds in `nsgp-verified.json`, the two
intake files and a dump of the live deadline table, and writes two things:

- `server/grant-knowledge-seed.json`, the bundle: a flat list of records, parents first,
  each with an `import_key`.
- `docs/gk-import-report.md`, everything it could not settle: dates that disagree between
  Drive, the web check and the live table; intake lines with no Drive counterpart; what
  Drive itself marks unknown; every contact it parsed out of free text.

```
node scripts/gk-extract.mjs --src "<…/Operations/grant-knowledge>" --live-deadlines live.json
node scripts/gk-data.mjs                         # shape of the bundle, and a test load
NPSA_API_KEY=… node scripts/gk-load.mjs          # dry run against production
NPSA_API_KEY=… node scripts/gk-load.mjs --apply  # load
```

What the YAML states imports as verified by the audit that stamped the file. Prose older
than that audit, anything flagged, anything from the web check or the live table that a
person did not type, and any contact with a caveat imports unverified and waits in the
queue. A ruling goes in `scripts/gk-rulings.json` (`records`, `patch`, `skip`); re-extract
after adding one.

Loading twice is safe. A record the import made and nobody has touched is brought up to
the bundle; one a person or Claude has edited is skipped and listed; one that already
exists by hand under the same key is left alone.

## Checks

`node scripts/gk-data.mjs` checks the bundle's shape (57 jurisdictions, schemas, parents,
zones, named regressions such as Texas's two stages) and loads it twice through the
routes.


`node scripts/gk-smoke.mjs` runs the routes against the in-memory store with an injected
clock: no database, no network. Run it under Node 18 as well
(`npx -p node@18 node scripts/gk-smoke.mjs`), which is what Railway runs.
