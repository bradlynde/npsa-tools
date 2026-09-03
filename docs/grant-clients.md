# Grant clients module

Phase 2, step 2 of the roadmap in [mcp.md](mcp.md). Written 2026-09-02 as the plan for the
work; it is kept current as each PR lands, so the "Status" line below says what is real.

**Status:** PR 1 (schema, catalog, routes), PR 2 (MCP tools) and PR 3 (the client page,
with its Vercel passthrough on the `frontend` branch) are in. Uploads come next, then
the import and cutover, so no client loses the Documents tab in between.

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
`X-Internal-Key` (with `X-Actor: <key fingerprint>` so the audit line names the person).
The team gate accepts that, or a bearer from `MCP_API_KEYS`. With `MCP_API_KEYS` unset
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
client_contacts (id, client_id → clients, name, email, role, is_primary, added_by, created_at, UNIQUE (client_id, email))
intake_answers  (client_id → clients, key, value, updated_at, updated_by, PRIMARY KEY (client_id, key))
intake_uploads  -- PR 5: id, client_id, key, filename, mime, size_bytes, content BYTEA, drive_file_id, drive_url, uploaded_by, uploaded_at
```

`updated_by` reads `client` or `client:<who>` (from the page, `who` being the "Who is
filling this out?" answer), `seed:<actor>` (a team write, actor = key fingerprint), or
`import`.

### The question catalog

Not a table. `server/intake-questions.json` holds the 592 questions the page renders:
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

`server/intake-state-config.json` carries the per-state map the page's checklist banner
needs (SAA short name, programs, registration steps with a "— hard gate" suffix, per-site
and state caps), from `getStateConfig_` in the same build. The Kentucky registration line
was corrected live in the Apps Script editor on 2026-08-26 and never reached the local
copy; it is transcribed from the deploy note and should be checked against the live form
at cutover. `nsgp-data.json` holds SAA names and deadlines for reps; merging the two is a
follow-up.

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
| POST | `/api/clients` | team | Create. `name, state` required; `slug` derived from the name when omitted; `contacts[{name,email,role}]` (first becomes primary), `upload_folder_id, drive_folder_id, asana_project_gid, kickoff_date (YYYY-MM-DD), program_track, notes, phase, status`; `token` only for imports. 201 with the row; 409 on a slug clash; 400 with the reason otherwise. |
| GET | `/api/clients/:slug` | team | Row, contacts, `intake_url`, SAA, core and checklist counts, `filled_by`, `status_line`. |
| PATCH | `/api/clients/:slug` | team | Any create field except slug/token, plus `phase`, `status`, `add_contacts[]`, `remove_contact_emails[]`. `status=submitted` stamps `submitted_at`. "Nothing to change" is a 400. |
| POST | `/api/clients/:slug/token` | team | Rotate the token; returns the new `intake_url`. The old link stops working at once. |
| GET | `/api/clients/:slug/answers?section=&include_empty=` | team | Answers in catalog order with `section, label, kind, value, updated_at, updated_by`. Empty values omitted unless asked. |
| PUT | `/api/clients/:slug/answers` | team | Upsert `{ answers: {key: value}, by? }`. Unknown keys → 400 with `unknown_keys`; nothing written. Values become strings, capped at 20k chars. Does not touch the quiet clock. |
| GET | `/api/clients/:slug/status` | team | Per-section answered/total, the 24 checklist items with status/due/owner/note, core counts, `filled_by`, `status_line`, submitted and last-activity times, uploads (PR 5). |
| GET | `/client/:slug?t=` | token | The intake page (PR 3). Until then a valid link gets a 503 "not deployed here yet" page. Wrong token → the same "invalid or expired" page as today, HTTP 404. Rescues a Gmail-mangled query (`?client%3Dslug%26t%3Dtoken&source=gmail…`) the way `doGet` did. |
| PUT | `/api/intake/:slug/answers` | token | Client autosave: `{ answers: {key: value} }`. Catalog keys only, no meta keys. Bumps `last_client_activity_at`. |
| POST | `/api/intake/:slug/complete` | token | Writes `_status = "Submitted <date> CT by <who>"`, sets `status=submitted` and `submitted_at` if the client was active. No email in this build. |
| POST | `/api/intake/:slug/upload` | token | PR 5. |
| GET | `/api/clients/:slug/uploads[/:id]` | team | PR 5. |

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

Writes, description opening `WRITE. Confirm with the user before calling.`, each logged
with the caller's key fingerprint:

| Tool | Inputs | Route |
| :-- | :-- | :-- |
| `client_create` | `name`, `state`, `slug?`, `contacts?`, `upload_folder_id?`, `drive_folder_id?`, `asana_project_gid?`, `kickoff_date?`, `program_track?`, `notes?` | `POST /api/clients`. Returns the row with `intake_url`, the link for the kickoff email. |
| `client_update` | `slug` + any of the fields above except slug, plus `phase`, `status`, `add_contacts[]`, `remove_contact_emails[]` | `PATCH /api/clients/:slug` |
| `intake_seed` | `slug`, `answers` (key → string), `by?` | `PUT /api/clients/:slug/answers`. Unknown keys come back as a tool error naming them. |
| `client_token_rotate` | `slug` | `POST /api/clients/:slug/token`. Destructive: the old link dies. |

## The intake page

`server/intake/client.html` is the deployed `Index.html` (Version 24 field set) with the
Apps Script template tags turned into `{{placeholders}}` that `renderClientPage` fills
as JSON (with `<`, `>` and the Unicode line separators escaped, the way the Apps
Script's `jsForInject_` did), and the three `google.script.run` calls replaced by
`fetch` against `/api/intake/<slug>/answers`, `/api/intake/<slug>/complete` and
`/api/intake/<slug>/upload`. The token travels in the `X-Intake-Token` header. A 401 on
any call turns the save pill into "this link is no longer valid" instead of retrying
forever. Everything a client sees stays the same. Until uploads land, the upload route
answers 503 with a sentence the Documents tab shows ("email the file to your NPSA
contact").

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
`INTAKE_API_BASE` (optional, default relative) points the page's calls at another origin;
uploads may need it, because Vercel functions cap request bodies at 4.5 MB while the
form allows 25 MB, so the uploads PR will either post straight to Railway with CORS or
size the passthrough accordingly.

## Cutover for existing clients (after uploads)

1. `scripts/intake-import.mjs` reads an `.xlsx` export of the Registry spreadsheet
   (Registry tab plus every `R · <slug>` tab; the hidden `_key` column exports) and POSTs
   each client and their answers to the team routes with an MCP key. Slug, token and the
   Phase 2 folder id (Registry column F) are preserved; `updated_by = import`; `--dry-run`
   first. Cancelled clients import as `status=cancelled`.
2. An Apps Script stub replaces `Code.gs` on the same deployment id, so no URL changes:
   `doGet` looks up the Registry row and, on a matching token, shows "This form has moved"
   and sends the browser to `<INTAKE_BASE_URL>/client/<slug>?t=<token>`; `doPost` returns
   `{ error: "moved" }` so any stale skill call fails loudly.
3. Every imported client's old link is opened once to confirm the redirect and the
   answers, then `intake_status` for each.
4. The spreadsheet stays as an archive. Nothing writes to it after the stub deploys.

## Skill migration (after PR 2; edits only with Stuart's go-ahead)

- **nsgp-inhouse-kickoff** Step 3 becomes `intake_questions` → `client_create` →
  `intake_seed` → `intake_status`, with the link from the create response. The curl,
  Chrome, editor and manual paths, `FORM_ADMIN_KEY`, and the tracker step go away.
- **nsgp-ij-draft** reads answers with `intake_answers` instead of the Registry sheet.
- **nsgp-inhouse-closeout** renders the archive from `intake_answers`, then
  `client_update status=closed` (or `cancelled`).

## Uploads (next PR)

Multipart to `/api/intake/:slug/upload`, one file, PDF/JPG/PNG checked by magic bytes,
25 MB cap, bytes in `intake_uploads.content`. Team list/download routes and an
`intake_uploads_list` tool. If `GOOGLE_SERVICE_ACCOUNT_JSON` is set, a best-effort push
into `upload_folder_id` (JWT-signed access token, Drive multipart upload with
`supportsAllDrives=true`); failure leaves the Postgres copy intact and the client never
sees a Drive error.

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
node scripts/mcp-smoke.mjs      # the MCP layer, including the nine grant-client tools
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
3. The Registry export for the import: download the spreadsheet as `.xlsx` when PR 4 is
   ready, and confirm which clients are still active.
4. Where client folders live (Shared Drive vs My Drive) only matters for the optional
   Drive mirror in PR 5.
