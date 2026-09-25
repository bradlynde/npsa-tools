# Grant clients module

Phase 2, step 2 of the roadmap in [mcp.md](mcp.md). Written 2026-09-02 as the plan for the
work; it is kept current as each PR lands, so the "Status" line below says what is real.

**Status:** all five PRs are in: schema and routes, MCP tools, the client page with its
Vercel passthrough, uploads, and the import script with the Apps Script redirect stub.
What remains is the cutover itself (below) and the skill edits after it.

## Why

NPSA's in-house NSGP intake runs on a Google Apps Script web app. One deployment serves
every client through `…/exec?client=<slug>&t=<token>`; a Registry sheet plus one
`R · <slug>` tab per client hold 592 keyed answers; uploads go to the client's Phase 2
Drive folder; register/seed/track are POST endpoints behind an admin key.

It works, but it is not repeatable for a second grant writer:

- Registering and seeding a client from a session means browser tricks (`no-cors` POSTs,
  editor automation) because `script.google.com` is blocked from the sandbox, and the
  seed response is opaque, so every seed is verified by re-reading the sheet.
- Field keys are guessed. Truncated stems (`…_information_collection_workbook_co`) and
  keys that land in the "Other" bucket have cost real time.
- The intake-links tracker is a separate sheet appended by a `track` endpoint.
- The admin key lives in an installed skill in plaintext and is kept in sync by hand.
- Nothing reports "where is each client" without opening the spreadsheet.

This module moves client registration, the tokenized intake link, the question catalog,
answers, and status into this backend, and exposes them as MCP tools. A kickoff becomes:
`client_create`, `intake_seed`, `intake_status`, hand over the link.

## Decisions

| # | Decision | Choice |
| :-- | :-- | :-- |
| 1 | First-cut scope | Registration, tokenized link, question catalog, answers in Postgres, status, the client-facing page, and an import of current Registry clients with their existing tokens plus an Apps Script redirect stub so links already in inboxes keep working. Uploads deferred to PR 5. |
| 2 | Uploads | Stored on the backend first (Postgres, 25 MB cap, PDF/JPG/PNG), listed and downloadable through team routes and an MCP tool. A Drive mirror into the Phase 2 folder is an optional add-on behind one Railway variable (a service account), so nothing waits on Google Cloud setup. If Drive never gets configured, the team downloads from the tool or clients email files. |
| 3 | First MCP tools | Nine: `clients_list`, `client_get`, `intake_questions`, `intake_answers`, `intake_status` (reads); `client_create`, `client_update`, `intake_seed`, `client_token_rotate` (writes). |
| 4 | Auth split | Team routes under `/api/clients` require an MCP key, or the process's boot-time internal secret for loopback calls from the MCP layer. Client-facing routes are token-only and public, exactly like today, because clients forward the link to their own staff. The client record carries `phase` and `status` so an internal dashboard and a phase-scoped client portal can grow on it. Email-code verification for clients is a later PR (design below). |
| 5 | Client URL | Served through the Vercel app (`npsa-tools.vercel.app/client/<slug>?t=<token>`, later a custom domain on that project) by a thin passthrough to Railway. The backend also serves the page directly. |

## Architecture

```
Claude (Code / Desktop)
   │  MCP bearer key
   ▼
POST /mcp  ──loopback + X-Internal-Key──▶  /api/clients/*        (team, keyed)
                                            /api/intake/questions (team, keyed)
                                            /api/intake/:slug/*   (client, token)
                                            GET /client/:slug     (page, token)
                                                   │
                                              Postgres: clients, client_contacts,
                                                        intake_answers, intake_uploads
Vercel app (frontend branch)
   /client/[slug]        → passthrough of GET /client/:slug on Railway
   /api/intake/[...path] → passthrough of the client API (no login)
   (later) /api/clients/[...path] → proxy with a server-held MCP key, behind team login
```

Code: `server/intake.js`. It exports `ensureIntakeSchema(pool)` (called at boot from
`server/index.js`), `createIntakeStore(pool)` and `createMemoryStore()` (same surface, the
second for tests), and `registerIntake(app, { store, internalKey, publicBase, renderPage })`,
mounted ahead of `registerMcp` and the SPA fallback because `/client/:slug` is not under
`/api`.

### The internal key

`server/index.js` mints a random `INTERNAL_KEY` per process and hands it to both
`registerIntake` and `registerMcp`. The MCP layer's loopback calls present it as
`X-Internal-Key` (with `X-Actor: <name or key fingerprint>` so the audit line names the person).
The team gate accepts that, or a bearer from `MCP_API_KEYS`. A bearer is named by
`MCP_KEY_NAMES` when it has an entry and by its fingerprint otherwise; only a key on
`ACTOR_PROXY_KEYS` (the toolbox's) may name someone else with `X-Actor`. With `MCP_API_KEYS` unset
nothing from outside gets in: no key, no service, the same rule as `/mcp`.

The older `/api` routes (letters, reps, marketing) have no gate of their own and are
unchanged here; putting the same gate on them once the Vercel proxy forwards a key is a
separate, small PR.

## Schema (created on boot with `CREATE TABLE IF NOT EXISTS`)

```sql
clients (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE,            -- ^[a-z0-9]+(-[a-z0-9]+)*$, 3–60 chars; "questions" is reserved
  name TEXT, state TEXT,       -- two-letter USPS
  token TEXT UNIQUE,           -- 20 hex chars (crypto.randomBytes(10)); imports keep their old 12
  phase INT DEFAULT 2,         -- 1 sales · 2 grant writing · 3 compliance · 4 implementation
  status TEXT DEFAULT 'active',-- active | submitted | cancelled | closed
  program_track TEXT,          -- e.g. "2026 federal + NSGP-IL"
  drive_folder_id TEXT,        -- client root folder
  upload_folder_id TEXT,       -- Phase 2 folder (uploads target, PR 5)
  asana_project_gid TEXT,
  kickoff_date DATE,           -- Day 0
  notes TEXT,
  created_at, updated_at, submitted_at,
  last_client_activity_at      -- bumped only by client-page saves: the quiet clock
)
client_contacts (id, client_id → clients, name, email, role, phone, side, is_primary, added_by, created_at, UNIQUE (client_id, email))
  -- side: 'client' (their people) or 'npsa' (ours: Stuart and Brad from server/intake-team.json, plus the consultant who brought the client in, role "Consultant")
intake_answers  (client_id → clients, key, value, updated_at, updated_by, PRIMARY KEY (client_id, key))
intake_uploads  -- PR 5: id, client_id, key, filename, mime, size_bytes, content BYTEA, drive_file_id, drive_url, uploaded_by, uploaded_at
```

`updated_by` reads `client` or `client:<who>` (from the page, `who` being the "Who is
filling this out?" answer), `seed:<actor>` (a team write, actor = key fingerprint), or
`import`.

### The question catalog

Not a table. `server/intake-questions.json` holds the 679 questions the page renders (592 from the Apps Script build, plus 14 more program rows and a per-site `loc<n>_infra` research field added 2026-09-03; `q_3_2_1` and `resp_q_4_6` are retired as meta):
`key, section, label, ordinal, kind` (`text | textarea | select | upload | meta`). It was
generated from the deployed Apps Script build (Version 24): the `FIELDS` array in
`Code.gs` for keys, sections, labels and order, and the element type per `data-key` in
`Index.html` for kind. From now on it is edited by hand; the Python generator in the
Grant Writing folder is retired for this form. Adding a question is one entry here and
one element in the page HTML.

The catalog is the contract for writes. A seed naming a key that is not in it is refused
with the offending keys and nothing is written, which replaces the "did it land under
Checklist or Other?" check that used to follow every seed. `_status` is `meta`: the
server writes it on completion, the page cannot, imports may.

The page's per-state facts (SAA, registration steps, caps, upload rows, the programs an
application can name, reference contacts) come from the grant knowledge base's verified
records; see [grant-knowledge.md](grant-knowledge.md#the-client-intake-pages). They used
to live in `intake-state-config.json` and `intake-documents.json`, extracted from the
Apps Script build; B8 deleted both.

## Routes

Auth: **team** = `Authorization: Bearer <key in MCP_API_KEYS>` or `X-Internal-Key`.
**token** = `X-Intake-Token` header for API calls, `?t=` on the page URL. Tokens are
compared with `timingSafeEqual`; a wrong token gets the same answer as an unknown slug,
so the client endpoints never confirm which slugs exist. All JSON. `express.json` is
pre-registered at 2 MB for `/api/clients` and `/api/intake` so a full seed fits.

| Method | Path | Auth | What it does |
| :-- | :-- | :-- | :-- |
| GET | `/api/intake/questions?section=&prefix=` | team | The catalog, with the section list. |
| GET | `/api/clients?status=&phase=&search=` | team | Clients with `intake_url`, contacts, SAA, core answered/total, checklist completed/total, `filled_by`. `status` defaults to `active`; `all` lists everything. |
| POST | `/api/clients` | team | Create. `name, state` required; `slug` derived from the name when omitted; `contacts[{name,email,role,phone}]` (the client's people; first becomes primary), `npsa_contacts[]` (ours beyond the standing team in `server/intake-team.json`, usually the sales rep), `upload_folder_id, drive_folder_id, asana_project_gid, kickoff_date (YYYY-MM-DD), program_track, notes, phase, status`; `token` only for imports. The state's verified SAA, program and CISA contacts are added as reference rows unless `reference_contacts` is `false` (or a list, which replaces them). 201 with the row; 409 on a slug clash; 400 with the reason otherwise. |
| GET | `/api/clients/:slug` | team | Row, contacts, `intake_url`, SAA, core and checklist counts, `filled_by`, `status_line`. |
| PATCH | `/api/clients/:slug` | team | Any create field except slug/token, plus `phase`, `status`, `add_contacts[]`, `add_npsa_contacts[]`, `remove_contact_emails[]`. `status=submitted` stamps `submitted_at`. "Nothing to change" is a 400. Also `add_reference_contacts` (SAA, CISA; read-only for the client), and the Documents-tab list: `documents` (full list or `null` to reset), `add_documents`, `remove_document_keys`. Defaults come from `server/intake-documents.json` (standard four plus per-state extras; a `by_program` entry replaces them when the client's state and `program_track` match, so a California CSNSGP client gets the Cal OES set). A document may carry `ready` (its line in the checklist's submission box) and `task` (the checklist stem that also satisfies it, or removes it when marked Not applicable). |
| POST | `/api/clients/:slug/token` | team | Rotate the token; returns the new `intake_url`. The old link stops working at once. |
| GET | `/api/clients/:slug/answers?section=&include_empty=` | team | Answers in catalog order with `section, label, kind, value, updated_at, updated_by`. Empty values omitted unless asked. |
| PUT | `/api/clients/:slug/answers` | team | Upsert `{ answers: {key: value}, by? }`. Unknown keys → 400 with `unknown_keys`; nothing written. Values become strings, capped at 20k chars. Does not touch the quiet clock. |
| GET | `/api/clients/:slug/status` | team | Per-section answered/total, `wish_list` (per facility: items with a priority set, each with answered/5 detail fields and a parsed `cost`, the facility name from `loc<n>_name`, and `budget` {items, ma, ma_on, ma_default, total, cap 200000, room, uncosted}; M&A is on by default at 5% of the items, `wl_f<n>_ma_on`/`wl_f<n>_ma_amount` override), `budget` (applicant total vs what the applications allow: each active site's programs from `loc<n>_programs`, federal $200,000 a site plus the state program's per-site cap held to its per-applicant cap; `capsFor(state, sites)` in `server/intake.js`), `programs` (`listed` rows with a name out of 20 `slots`; Programs is not in the core count), the 24 checklist items with status/due/owner/note, core counts, `filled_by`, `status_line`, submitted and last-activity times, uploads. |
| GET | `/client/:slug?t=` | token | The intake page (PR 3). Until then a valid link gets a 503 "not deployed here yet" page. Wrong token → the same "invalid or expired" page as today, HTTP 404. Rescues a Gmail-mangled query (`?client%3Dslug%26t%3Dtoken&source=gmail…`) the way `doGet` did. |
| PUT | `/api/intake/:slug/contacts` | token | Client edits one of their own people (`email` identifies; `name`, `role`, `phone`, optional `new_email`). NPSA and reference rows refuse. |
| PUT | `/api/intake/:slug/answers` | token | Client autosave: `{ answers: {key: value} }`. Catalog keys only, no meta keys. Bumps `last_client_activity_at`. |
| GET | `/api/intake/:slug/contacts` | token | `{ npsa: [...], client: [...] }` with name, role, email, phone, added_by. |
| POST | `/api/intake/:slug/contacts` | token | Adds one of the client's people: `name`, `email` required, `role`, `phone` optional. Same email updates the row. Refuses an NPSA address. Bumps the quiet clock. |
| DELETE | `/api/intake/:slug/contacts?email=` | token | Removes one of the client's people. NPSA rows are refused. |
| DELETE | `/api/clients/:slug?confirm=<slug>` | team | Deletes the client and everything under it. Without a matching `confirm` it writes nothing and answers with what would be lost; an `active` client is refused until it is cancelled or closed. |
| POST | `/api/intake/:slug/upload` | token | Multipart with fields `key` (an upload question) and `file`. PDF/JPG/PNG decided by the file's first bytes, 25 MB cap. Stores the file, writes the `up_*` answer, mirrors to Drive when configured. Answers CORS for the page's origin only. |
| GET | `/api/clients/:slug/uploads` | team | Uploads with label, filename, type, size, uploader, time, Drive link and download path. |
| GET | `/api/clients/:slug/uploads/:id` | team | The file bytes, as an attachment. |

`intake_url` is `INTAKE_BASE_URL` + `/client/<slug>?t=<token>`; unset, the request host
is used. Set the variable to `https://npsa-tools.vercel.app` once the passthrough is live,
and to the custom domain after that. Links already sent keep working across the change
because the `.vercel.app` alias stays.

## MCP tools

Reads, annotated read-only:

| Tool | Inputs | Route |
| :-- | :-- | :-- |
| `clients_list` | `status?` (active/submitted/cancelled/closed/all), `phase?`, `search?`, `limit?` | `GET /api/clients` |
| `client_get` | `slug` | `GET /api/clients/:slug` |
| `intake_questions` | `section?`, `prefix?` | `GET /api/intake/questions`. The description tells Claude to look keys up here before seeding. |
| `intake_answers` | `slug`, `section?`, `include_empty?` | `GET /api/clients/:slug/answers` |
| `intake_status` | `slug` | `GET /api/clients/:slug/status` |
| `intake_uploads_list` | `slug` | `GET /api/clients/:slug/uploads` (metadata and download path; bytes stay on the backend) |

Writes, description opening `WRITE. Confirm with the user before calling.`, each logged
with the caller's key fingerprint:

| Tool | Inputs | Route |
| :-- | :-- | :-- |
| `client_create` | `name`, `state`, `slug?`, `contacts?`, `upload_folder_id?`, `drive_folder_id?`, `asana_project_gid?`, `kickoff_date?`, `program_track?`, `notes?` | `POST /api/clients`. Returns the row with `intake_url`, the link for the kickoff email. |
| `client_update` | `slug` + any of the fields above except slug, plus `phase`, `status`, `add_contacts[]`, `remove_contact_emails[]` | `PATCH /api/clients/:slug` |
| `intake_seed` | `slug`, `answers` (key → string), `by?` | `PUT /api/clients/:slug/answers`. Unknown keys come back as a tool error naming them. |
| `client_token_rotate` | `slug` | `POST /api/clients/:slug/token`. Destructive: the old link dies. |

## The intake page

`server/intake/client.html` is the deployed `Index.html` (Version 24 field set) plus a seventh
tab, **Contacts**: "Your NPSA team" (Stuart, Brad and the consultant, from `client_contacts`
rows with `side = npsa`) and "Your team" (the client's people, which the client can add to
and remove from on the page). The rows are injected at render and the tab talks to
`/api/intake/<slug>/contacts`. Otherwise it is the form with the
Apps Script template tags turned into `{{placeholders}}` that `renderClientPage` fills
as JSON (with `<`, `>` and the Unicode line separators escaped, the way the Apps
Script's `jsForInject_` did), and the three `google.script.run` calls replaced by
`fetch` against `/api/intake/<slug>/answers` and
`/api/intake/<slug>/upload`. The token travels in the `X-Intake-Token` header. A 401 on
any call turns the save pill into "this link is no longer valid" instead of retrying
forever. Everything a client sees stays the same.

The page is served two ways:

- Directly by Railway at `GET /client/:slug`.
- Through the Vercel app by a passthrough on the `frontend` branch:
  `app/client/[slug]/route.ts` forwards the page, `app/api/intake/[...path]/route.ts`
  forwards the two client verbs under `/api/intake` with the token header. Neither is
  behind the team login, and the keyed `/api/clients` routes are not reachable through
  it. The page uses relative URLs, so it works on either host.

`INTAKE_BASE_URL` on Railway sets the host that goes into `intake_url`:
`https://npsa-tools.vercel.app` once the passthrough is live, and the custom domain
after it is added to the `npsa-tools` Vercel project with a CNAME in Squarespace DNS.
`INTAKE_UPLOAD_BASE` (optional) is where the page sends file uploads. Vercel functions
cap request bodies at 4.5 MB while the form allows 25 MB, so set it to the Railway origin
(`https://loe-generator-production.up.railway.app`) once the page is served from Vercel;
the upload route answers CORS preflight for `INTAKE_BASE_URL`'s origin and no other. Every
other call stays relative. `INTAKE_API_BASE` (optional) does the same for the rest of the
page's calls, should that ever be wanted.

## Cutover for existing clients

Two files do it: `scripts/intake-import.mjs` and `scripts/apps-script-redirect.gs`.

### 1. Set the Railway variables

- `INTAKE_BASE_URL=https://npsa-tools.vercel.app` (or the custom domain once it is on
  the Vercel project), so links mint on the address clients will keep.
- `INTAKE_UPLOAD_BASE=https://loe-generator-production.up.railway.app`, so files over
  Vercel's 4.5 MB body cap still upload.
- `GOOGLE_SERVICE_ACCOUNT_JSON` only if the Drive mirror is wanted (see Uploads).

Redeploy, then open `https://npsa-tools.vercel.app/client/nobody?t=x` and confirm the
"link not recognized" page comes back through Vercel.

### 2. Export the spreadsheet

In the intake spreadsheet (`14nx-G0dZbqn0js0a9Yb3rCD-IV1Fdsf7fHF9kNAG2qk`): File →
Download → Microsoft Excel. Keep it out of `~/Documents` (it holds tokens); scratch space
or Downloads is fine, and delete it afterwards.

### 3. Dry run, then import

```bash
node scripts/intake-import.mjs ~/Downloads/registry.xlsx --dry-run
```

The dry run needs no key. It reads every `R · <slug>` tab, lists each client with the
number of answers it would write, the keys the form no longer renders (old seeds that
landed in the sheet's "Other" bucket, which are skipped rather than sent), and warnings
for a missing tab, a missing token, or a missing Phase 2 folder id. Decide statuses from
it: cancelled or closed clients import with `--status slug=cancelled,slug=closed`; a
client to leave out goes in `--skip`. Then:

```bash
MCP_API_KEY=… node scripts/intake-import.mjs ~/Downloads/registry.xlsx --status masters-academy=cancelled
```

Slug and token are kept, so old links redirect to the same client; the Phase 2 folder id
comes from Registry column F; answers land with `updated_by = import`. The sheet's
"Updated" timestamps are not carried over (every imported answer is dated by the import).
Re-running is safe: an existing client is left as it is and its answers are written
again.

### 4. Check, then redirect

Open `intake_status` (or `clients_list`) for each imported client and spot-check a
couple of answers against the sheet. Then, in the Apps Script editor for "NSGP Intake
Form v1": paste `scripts/apps-script-redirect.gs` over `Code.gs` (set `NEW_BASE` to the
same value as `INTAKE_BASE_URL` first), delete `Index.html`, and Deploy → Manage
deployments → edit the active deployment → Version: New version → Deploy. Editing the
existing deployment keeps every URL already sent; "New deployment" would not.

From then on an old link looks the slug up in the Registry, checks the token, and shows a
button that opens `<NEW_BASE>/client/<slug>?t=<token>`. A button rather than an automatic
hop: Apps Script serves the page in a sandbox that only lets a real click leave it. The
register / seed / track endpoints answer `{ "error": "moved" }` so a stale skill call
fails loudly instead of writing to a sheet nobody reads.

Open one old link per client to see it land, then tell the installed skills (kickoff,
IJ draft, closeout) about the new tools; those edits are a separate step with Stuart.
The spreadsheet stays as an archive; nothing writes to it after the stub deploys.

## Skill migration (after PR 2; edits only with Stuart's go-ahead)

- **nsgp-inhouse-kickoff** Step 3 becomes `intake_questions` → `client_create` →
  `intake_seed` → `intake_status`, with the link from the create response. The curl,
  Chrome, editor and manual paths, `FORM_ADMIN_KEY`, and the tracker step go away.
- **nsgp-ij-draft** reads answers with `intake_answers` instead of the Registry sheet.
- **nsgp-inhouse-closeout** renders the archive from `intake_answers`, then
  `client_update status=closed` (or `cancelled`).

## Uploads

The Documents tab posts multipart to `/api/intake/:slug/upload`. The server reads it with
Node's own `Response.formData()` (no new dependency; works on the Node 18 image),
decides the type from the file's first bytes (`%PDF`, JPEG and PNG signatures) rather
than the declared type, caps it at 25 MB, and stores the bytes in `intake_uploads`.
The `up_*` answer becomes "<filename> (uploaded <date>)" so the form shows "Uploaded ✓"
on the next visit, and the client's quiet clock resets. The team reads the list through
`GET /api/clients/:slug/uploads` or `intake_uploads_list`, and the bytes through
`GET /api/clients/:slug/uploads/:id` with a bearer key.

### Drive mirror (optional)

Set `GOOGLE_SERVICE_ACCOUNT_JSON` on Railway to the contents of a service account's key
file and every upload is also pushed into the client's `upload_folder_id` (their Phase 2
folder) by `server/drive.js`: the account signs a JWT, trades it for an access token, and
sends one multipart upload with `supportsAllDrives=true`. The Drive link is recorded on
the upload row and appended to the `up_*` answer. A Drive failure is logged and the
Postgres copy stands; the client never sees it. Without the variable nothing is
attempted.

One-time setup: create a service account in a Google Cloud project, enable the Drive
API, create a JSON key, paste it into the Railway variable, and add the account's email
(`…@…iam.gserviceaccount.com`) to the Shared Drive that holds client folders as a
Content Manager. A folder on someone's My Drive also works if shared with that email,
but then the service account owns the files and they count against its own 15 GB. If the
Google Cloud side proves painful, skip it: the files are in Postgres and the tool, and
clients can always email them.

## Client email verification (later)

The schema anticipates it. `client_contacts` is the allowlist; kickoff seeds the primary
contact. A later `allowed_domains` column lets anyone at the client's domain verify with a
six-digit code (through the mail provider the team's auth service already uses) and a
30-day cookie, with no invite. A colleague on another domain is added self-serve by a
verified contact from the page, or by NPSA with `client_update add_contacts`. The token
stays the link mechanism, so nothing already sent breaks when the gate turns on, and it
can be enabled per client to trial.

## Checking it

```bash
node scripts/intake-smoke.mjs   # routes against the in-memory store: gates, registration, answers, status, updates
node scripts/mcp-smoke.mjs      # the MCP layer, including the grant-client tools
node scripts/intake-import-smoke.mjs   # the workbook reader and the import against a fake API
```

Both run with no database or network. Railway runs `node:18-alpine` while local and CI run
Node 20+, so both are also run under Node 18 (`npx -p node@18 node scripts/…`) before a PR
is marked ready.

After a deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://loe-generator-production.up.railway.app/api/clients
```

`401` means the routes are live and gated. With a bearer key from `MCP_API_KEYS` the same
call returns `[]` until the first client is created.

## Open questions

1. Hostname for the client link once a custom domain is added to the Vercel project.
2. Email on submit. `markComplete` used to email Stuart. Skipped here; `clients_list`
   with `status=submitted` and the daily run surface it. Revisit if missed.
3. Which clients are active vs cancelled or closed at import time; the dry run lists
   them and `--status` sets it per client.
4. Where client folders live (Shared Drive vs My Drive) only matters for the optional
   Drive mirror in PR 5.

## Submission box (2026-09-17)

The "What <state> needs for your submission" box on the Checklist tab is built from the
client's own Documents list, between SAM.gov and state registration at the top and vendor
quotes, the IJ and the submission at the bottom. A document row checks off when the file is
uploaded or its linked checklist task is marked Completed. Any requirement whose tasks are all
marked Not applicable leaves the box and the count (it used to show a green check). Change the
box by changing the client's Documents list.

## Applications (2026-09-17)

`clients.applications` (JSONB) is the list of applications NPSA is writing for a client:
`{ id: "a1", program: "CSNSGP" | "NSGP-S" | "NSGP-UA" | <state acronym>, cycle: "2026-27", sites: [1], status }`.
Status is `active` (writing now), `planned` (a later cycle we are engaged for), `submitted`,
`awarded`, `not_awarded` or `withdrawn`. Programs come from `programsFor(state)`: the two federal
tracks plus the state's own programs in the NSGP state reference. Set it with `client_create` /
`client_update applications` or the Grant Writing dialog (Edit). Ids are stable so later work
(one wish list per application) can key off them.

What reads it:
- The client form's header shows a chip per application; the Locations tab shows each site's
  applications in place of the "Programs applying" select.
- Site caps count `active`, `submitted` and `awarded` applications; `planned` stays out of
  today's caps.
- `documentsFor` matches `by_program` against stored applications (falling back to
  `program_track` when none are stored).
- `intake_status` returns `applications` and `applications_set`. When nothing is stored the list
  is derived from the Locations tab's answers and marked `derived: true`.

### One wish list per application

The first application (`a1`) keeps the catalog's `wl_f<n>_…` keys, so a client's existing wish list
becomes their first application's. Every other application stores the same questions under
`wl_<id>_f<n>_…` (e.g. `wl_a2_f1_vehicle_bollards_cost`); `normaliseAnswers` accepts them against
the `wl_f<n>_` twin, and `intake_answers` lists them after the catalog under sections like
`Wish List (NSGP-S FY2027) — Facility 1`. New application ids never reuse a lower number, so a new
application cannot inherit a removed one's answers.

- The page copies the three facility blocks per application before prefill and shows a "Wish list
  for" switcher; each list shows only its application's sites, its own site and application caps
  (federal $200,000 a site; a state program's per-site cap held to its per-applicant cap), and M&A.
- An empty list offers "Copy the <other application> list" for the sites both cover; the copy saves
  in one batch and the client edits from there.
- `intake_status.wish_lists[]`: `{ application, label, status, sites, prioritized, facilities, budget:
  { requested, cap, room } }`. The headline `budget` sums the lists whose application is active,
  submitted or awarded.

### The checklist splits the same way

`PER_APPLICATION_STEMS` — wish-list ideation and prioritization, budget finalization, IJ, final
review, assembly, submit — repeat for each application under `chk_<id>_status_…` / `_due_` / `_who_`
/ `_note_`; `a1` keeps the plain `chk_status_…` keys. Everything else stays shared, including the
prep, the drafting, the review with the client and the vendor quotes: a second application is an
add-on (its own wish list, its own submission) rather than a second engagement. So a client doing
CSNSGP now and a federal cycle later has one set of prep tasks and a submission date each.

Vendor quotes are a submission requirement only where the state asks for them: set
`quotes_required: true` on the state program's knowledge base record and the 889 row appears in its
submission box. We work from estimates everywhere else.

- The page adds an application header row before each block, so the table reads: shared stages 1–4,
  then each application's stages 5–7.
- The submission box repeats per application: the shared documents, plus that application's own IJ
  and submission. SAM.gov only shows on a federal application, since a state program does not need
  it, and the 889 quotes row only where the state requires quotes.
- `intake_status.checklist.items[]` carries `application` and `application_label` (both null on a
  shared task) and the counts include every application's copy; `per_application` says how many
  tasks repeat. `checklistTotal(client)` is the same arithmetic for the list route.
- `intake_answers` lists the extra keys under `Checklist (NSGP-S FY2027)`.

## Welcome email (2026-09-17)

When someone is added to a client's Contacts tab they get a short note with the intake link, the
way a shared Drive file tells you that you have access. It is sent **as the client's grant writer**
(the NPSA contact whose role says grant writer, else the first NPSA contact), so replies land in a
real inbox.

- **Automatic** when the client adds a colleague on their own form; the page then says "We have
  emailed them the link to this form."
- **On request** for the team: `client_update invite_contact_email` (or the Email link button in the
  Grant Writing dialog). This sends even to someone welcomed before, so it doubles as a re-send.
- NPSA and reference contacts are never mailed, an address is welcomed once automatically
  (`client_contacts.welcomed_at`), and a send that fails is logged while the contact stays added.
- `server/mail.js` holds the wording; change it there.

### Turning it on (Workspace admin, once)

1. Google Cloud → the `npsa-tools` project → enable the **Gmail API**.
2. Copy the intake-uploads service account's **client ID** (the numeric OAuth id).
3. Admin console → Security → Access and data control → API controls → **Domain-wide delegation** →
   Add new → that client ID, scope `https://www.googleapis.com/auth/gmail.send`.
4. Railway → `INTAKE_WELCOME_EMAIL=on`.

Until step 4, nothing is sent: contacts are added exactly as before and `welcomed` comes back false.
Step 3 lets the service account send as any user in the domain, so grant it the `gmail.send` scope
and nothing wider.

## Marking complete, and deleting (2026-09-18)

The Documents tab's "Mark as complete" button is gone, along with
`POST /api/intake/:slug/complete`. Clients pressed it once their uploads were in, which flipped the
record to `submitted` when nothing had been submitted to a state at all. The page now says the work
saves as it goes and there is nothing to submit there; `status=submitted` is the team's to set when
an application actually goes out.

Deleting a client is `DELETE /api/clients/:slug`, and `client_delete` over MCP. It takes two calls:
the first writes nothing and reports what would be lost (answers, uploads, contacts), and only a
second call with `confirm=<slug>` commits. An active client is refused outright. Deletion is for
demo and test records; a finished engagement is closed, not deleted.

## Documents received outside the form (2026-09-21)

Clients often email a file instead of uploading it. The team marks it received from the Grant
Writing dialog ("mark received" under any document not yet in, with undo), or with
`client_update mark_documents_received` / `unmark_documents_received`. Marks live in
`clients.documents_received` as `{ key: { at, by, note } }` and count as received everywhere an
upload would: the dialog's count, the client's Documents tab ("Received by your NPSA team ✓"), and
the submission box. The mark does not store the file; save the emailed copy to the client's Phase 2
folder as usual.

## Information Collection and Programs redesign (2026-09-21)

**Information Collection** shows one section at a time. A rail on the left lists the five sections
with an answered count and a progress bar each, plus the overall count, and "Who is filling this
out?" sits under it. Each section ends with Back / Next (section 5's Next goes to Programs), and the
page opens on the first section with questions left, with a "Welcome back" card, once the client has
answered anything. A link ending `#q-<section>-<n>` (e.g. `#q-3-9`) opens that section and scrolls to
the question; the grey number beside each question copies that link.

- **Numbers** are two levels. Section 3 was renumbered (3.1.1 → 3.1 … 3.3.5 → 3.13); keys did not
  change. The catalog now carries `number`, `prompt` (the wording the page shows) and `hint` for these
  questions, and the team answers route returns `number` and `prompt`, so the Grant Writing page and
  Claude say "3.9" for the same question the client sees.
- **Doesn't apply** is a link beside an empty answer. It stores the answer as the text `Doesn't apply`,
  so it counts as answered everywhere and reads plainly in the answers; Undo clears it.
- **NPSA notes** (`note_q_…`) show read-only under the answer, only when there is one. The client
  page no longer edits them, and the client save route drops any `note_…` key a stale page still
  sends. The team writes them from the Grant Writing page (`PATCH` with `question_notes`) or
  `intake_seed`. `_note_asks` (meta, comma-separated question keys) marks the notes that are questions
  for the client: amber on the page, "Question for you" beside the question, a dot on the section.
  The mark stays until the team clears it.
- **1.1 Primary contact** fills from the client's primary contact the first time the page opens with
  all four fields blank, written as `contacts`. A client edit is never overwritten.
- **State-only fields** hide by state: SAM.gov expiration (TX, IL) and volunteers (NY).
- **3.6** is a live summary of the Programs tab; **3.8** ("only one of its kind") counts as answered
  once a program is tagged Only one nearby.

**Programs** moved to tab 3 and is one card per program, 40 slots (was 20 table rows). Each card:
name (the card title), what it is, how often, people each time, Run by (Us / Outside group; Outside
asks for the group's name in `prog<n>_partner`), Where (`prog<n>_site`, comma-separated site numbers,
shown only when the client has two or more sites), and Who it serves (`prog<n>_demo` as
comma-separated tags from a preset list or typed; `prog<n>_unique` = `Yes` for Only one nearby). A
program seeded with `prog<n>_suggested` = `Yes` shows "Suggested by NPSA" and a Looks right button,
which clears it. A client with no programs sees an empty state instead of blank rows.

| Method | Path | Body | What it does |
| :-- | :-- | :-- | :-- |
| PATCH | `/api/clients/:slug` | `question_notes: { q_3_1_1: "…" }` | Writes NPSA notes (keys with or without `note_`), as `npsa:<actor>`. |
| PATCH | `/api/clients/:slug` | `note_asks: ["q_3_3_1"]` | Replaces the list of notes that are questions for the client. |

## Checklist redesign (2026-09-24)

The client's Checklist tab no longer shows the task table. It shows **Your tasks** (the client's open
tasks for the next three weeks, one bordered box per due date, nearest in amber, under a "Today" line;
To do / Working on it / Done on each; Later and Done fold away; tasks set to Not applicable
are hidden from the client entirely) and **What NPSA is
working on** (read-only, same date order). The table stays in the page, hidden, as the data layer:
its selects still autosave and feed the progress bar and the submission box.

- Who owns each task, and the client-facing wording, live in `server/intake-checklist.json`
  (`owner`: client | npsa, `title`, `hint`). Status items gain `side`, `title` and `prefix`.
- The client save route drops `chk_…` keys for NPSA-owned tasks, so only the team changes those.
- The team edits every task from the Grant Writing dialog (**Edit checklist**): `PATCH
  /api/clients/:slug` with `checklist: { "chk_status_<stem>": "Completed", "chk_due_<stem>": "11/20/2026",
  "chk_note_<stem>": "…" }` (per-application tasks use `chk_<id>_…`). Status must be Not started, In
  progress, Completed or Not applicable. Not applicable hides the task from the client.
- Notes that are only the "Day N" guide never show to the client.

## Task guides and tasks that don't apply (2026-09-25)

**How to do this.** The SAM.gov task and the state registration task carry a "How to do this" button on the client's checklist. It opens a box with an intro, a "Have these ready" list, numbered steps (a step may open with `**bold**`), how long to allow (from `lead_time_days`) and a link to the site. The text lives in the grant knowledge base, on each registration requirement: `client_hint` (the intro), `client_ready`, `client_steps` and `url`. Edit them in the Grant Knowledge tab; a new or changed field stays hidden from clients until someone verifies it. A state's own copy of SAM.gov (and a state program's) inherits the federal guide from the US record unless it writes its own. The button shows only where steps exist.

The state task takes the state's name ("Register with Illinois") and lists only the steps the client does: not SAM.gov, and not a step whose owner is `npsa`.

**Tasks the client isn't asked for.** `autoNotApplicable` (server/intake.js) reads these as Not applicable everywhere: hidden from the client, left out of the counts on the list, the dialog and the status tool, and marked with `auto` (the reason) on `intake_status` items and the Edit checklist pane.

| Task | Doesn't apply when |
| :-- | :-- |
| Leadership bios | The client's Documents list has no bios row. Add the row and the task comes back. |
| State registration | The state has no client-side registration step beyond SAM.gov (MI, ID, IN; California's CSNSGP). |
| SAM.gov | Every stored application is a state program that doesn't list SAM.gov (CSNSGP). NSGP-IL lists it, because GATA checks it. |
| Vendor quotes | Always, by default (`default` in intake-checklist.json). Quotes are asked for only when an item has no clear price (cabling, electrical), or where a state program requires them. |

Each applies while the status is blank or is a Not started that a seed or import wrote (any `by` label). A status set in Edit checklist (`npsa:<who>`) or by the client on the form stands, so picking To do in Edit checklist turns a task back on.

**Retired.** Preparedness efforts (law-enforcement relationships) duplicated Information Collection 3.9 to 3.13 and is retired (`retired` in intake-checklist.json): it no longer shows or counts anywhere; its keys stay in the catalog so old answers load.

**Other changes.** The vulnerability assessment row no longer says "(if you have one)": every client needs one, and NPSA helps them get it (a one-time update rewrites lists clients kept). The 501(c)(3) task tells a church with no IRS letter that its state nonprofit registration from the Secretary of State works instead.
