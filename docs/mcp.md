# MCP server

The Sales Toolbox backend exposes its data to Claude through the Model Context
Protocol at `POST /mcp` on the Railway service (the `loe-generator` lineage). Claude
Code and Claude Desktop connect to it directly and get tools for letters, reps,
pre-call bookings, the marketing dashboard figures, the in-house grant clients with
their intake forms, and the grant knowledge base -- twenty-six reads, and fifteen
writes for keys allowed them.

Code: `server/mcp.js`. Mounted from `server/index.js` ahead of the SPA fallback.

## Setup (once, on Railway)

1. Generate a key per person. Any long random string works:

   ```bash
   openssl rand -hex 32
   ```

2. On the `loe-generator` service in Railway, add a variable:

   ```
   MCP_API_KEYS   # comma-separated, one key per person
   ```

   The endpoint refuses every request until this is set (503). One key per person
   means one can be revoked without rotating the others. `MCP_API_KEY` (singular)
   also works for a single key.

   Optional:

   ```
   MCP_WRITE_KEYS   # comma-separated subset of MCP_API_KEYS allowed to use the write tools
   ```

   Unset, every key can write. Set, a key not on the list never sees the write
   tools at all, so a read-only key for someone who should only ask questions is
   one variable away.

   ```
   MCP_KEY_NAMES      # fingerprint:name pairs, e.g. ab12cd34:Stuart,ef567890:Brad
   ACTOR_PROXY_KEYS   # fingerprints of keys allowed to send X-Actor (the toolbox's key on Vercel)
   ```

   `MCP_KEY_NAMES` puts a person's name on audit lines and edit history instead of
   the key's fingerprint. The fingerprint is the first 8 hex characters of the key's
   SHA-256, the same value the log lines already print (`by ab12cd34`), so the
   variable holds nothing secret. `ACTOR_PROXY_KEYS` names the key the Next.js
   toolbox calls with: that app has already checked the person's login, so its
   `X-Actor` header is believed. From any other key the header is ignored.

3. Redeploy. Confirm with:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://loe-generator-production.up.railway.app/mcp
   ```

   `401` means it is live and gated. `503` means the variable is not set. `200`
   with HTML means the deploy has not picked up the route yet.

Keys are secrets. Do not commit them -- `.mcp.json` carries `${NPSA_MCP_KEY}`
rather than a key for exactly that reason -- and do not keep them under
`~/Documents` (iCloud-synced).

## The /api gate

Every `/api` route on this service needs a credential (`server/api-gate.js`,
mounted first in `server/index.js`). A route added later is locked by default.

| Caller | Credential | Reaches |
| :--- | :--- | :--- |
| MCP tools (loopback) | per-process internal key, sent automatically | everything |
| Vercel shell's proxies | a key from `MCP_API_KEYS`, as a bearer token | everything |
| Sales Toolbox iframe | the person's login token, handed in by the shell | everything |
| Zaps and backfill scripts | `X-Zap-Secret` | the Zapier routes only |
| Client intake page, GK uploads | the client's token, or a signed ticket | their own routes |

`/api/clients`, `/api/intake` and `/api/grant-knowledge` pass the gate untouched:
those modules check every route themselves.

Two Railway variables the gate depends on:

```
JWT_SECRET              # the same value as JWT_SECRET on Vercel (the auth service's secret)
ZAPIER_WEBHOOK_SECRET   # already set; the Zaps send it
```

Without `JWT_SECRET`, the toolbox iframe's calls are refused (no login token is
trusted unverified). Without `ZAPIER_WEBHOOK_SECRET`, the Zapier routes refuse
everything with 503; before the gate they accepted everything.

`scripts/api-gate-smoke.mjs` checks all of this with no database.

## Connecting

### Claude Code

```bash
claude mcp add --transport http npsa-tools https://loe-generator-production.up.railway.app/mcp --header "Authorization: Bearer YOUR_KEY"
```

Add `--scope user` to make it available in every project rather than just the
current one. Then `/mcp` inside Claude Code shows the server and its tools.

Or take the checked-in `.mcp.json` at the repo root, which points at the same
endpoint and reads the key from `NPSA_MCP_KEY`. That is why the key is an
expansion and not a literal: the file is committed, and a bearer token in a
public-ish repo is a bearer token anyone can use. Export it and Claude Code picks
the server up on its own, project-scoped, with no `claude mcp add` at all:

```bash
export NPSA_MCP_KEY=YOUR_KEY
```

### Claude Desktop

Desktop can use the custom connector described under claude.ai below. For a local
config instead, a bearer-key server goes in through the `mcp-remote` bridge. In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "npsa-tools": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://loe-generator-production.up.railway.app/mcp",
        "--header", "Authorization: Bearer ${NPSA_MCP_KEY}"
      ],
      "env": { "NPSA_MCP_KEY": "YOUR_KEY" }
    }
  }
}
```

Restart Desktop afterwards.

### Claude Code on the web

The `.mcp.json` above is what this reads too, but two things have to be true of the
ENVIRONMENT before it can connect, and neither is in the repo:

1. `NPSA_MCP_KEY` set as an environment variable on the Claude Code environment.
2. `loe-generator-production.up.railway.app` allowed by that environment's network
   policy. Egress is deny-by-default there, and a blocked host fails as a 403 on
   the proxy's CONNECT rather than anything the MCP client reports -- so the
   symptom of forgetting this is a server that simply never appears. Both are
   edited where the environment is configured:
   https://code.claude.com/docs/en/claude-code-on-the-web

### claude.ai connectors and Cowork

Add it as a custom connector pointing at
`https://loe-generator-production.up.railway.app/mcp`, with a request header
`authorization: Bearer <key>` carrying the person's key from `MCP_API_KEYS`. No
OAuth is involved: the endpoint checks the bearer key exactly as it does for Claude
Code. The key sits in the connector's settings, so give each person their own and
revoke it from `MCP_API_KEYS` if it leaks. This is separate from Claude Code on the
web above, which is a Claude Code client and reads `.mcp.json` like any other.

## Tools

Dollar figures USD, dates ISO, states two-letter. Read tools first, then writes.

| Tool | What it answers |
| :--- | :--- |
| `letters_stats` | Engagement-letter count, total fees, per-rep leaderboard |
| `letters_search` | Saved letters/proposals/addendums, filter by name or type |
| `letter_get` | One letter's form data and fee (HTML on request) |
| `reps_list` | Sales reps |
| `letter_template_get` | Template definition for a document type |
| `precall_bookings_list` | Upcoming Calendly consultations with pre-call facts |
| `precall_booking_get` | One booking by event URI |
| `marketing_overview` | Stats, funnel, application stats, Salesforce sync status |
| `marketing_breakdown` | Funnel grouped `by: "campaign"` (Instantly campaign id) or `by: "channel"` |
| `marketing_timeseries` | Bookings by week/month, or sales by month/quarter |
| `marketing_bookings` | Individual booking rows with attribution |
| `marketing_untracked_wins` | Wins with no matching booking |
| `clients_list` | In-house grant clients with phase, status, intake link, contacts (name, email, side), counts and quiet clock. A slim view: documents, applications and notes are in `client_get` |
| `client_get` | One client's record, contacts, documents, applications and headline intake counts |
| `intake_questions` | The intake form's key catalog; look keys up here before seeding |
| `intake_answers` | A client's intake answers in form order, filterable by section |
| `intake_status` | Per-section counts, the 24 checklist tasks, submission stamp, uploads |
| `intake_uploads_list` | A client's uploaded files with Drive link and team download path |
| `gk_overview` | Every jurisdiction (57): SAA, programs, cycle state, next deadline, how much is verified |
| `gk_state_get` | One jurisdiction in full, structured, with the id and version of every record |
| `gk_state_brief` | One jurisdiction as a markdown brief; replaces the Drive `states/XX.md` |
| `gk_requirements` | The submission checklist: federal baseline merged with state-added, owner, lead time, hard gates |
| `gk_search` | Search every record in every jurisdiction |
| `gk_needs_attention` | Unverified, stale, deadlines soon, open questions, holes |
| `gk_files_list` | The files kept for a jurisdiction: NOFOs, checklists, screenshots |
| `gk_revisions` | Who changed what, for a record, a jurisdiction, or everything; `limit` holds for all three |

Retired: `nsgp_deadlines_list` and `nsgp_state_reference` (the `gk_*` tools read the
same knowledge base directly; a deadline is a gk record), `marketing_by_campaign` and
`marketing_by_channel` (now `marketing_breakdown`), and `marketing_revenue_quality`
(the `/api/marketing/revenue-quality` route is still there for anyone who wants it).

### Write tools

Every write tool's description starts with `WRITE` and tells Claude to confirm the
exact change with the person before calling it. The MCP annotations say the same
for clients that read them: `readOnlyHint: false` on every write,
`destructiveHint: true` on `rep_remove`, `client_token_rotate` and `client_delete`,
and `idempotentHint: false` on the ones where a second identical call does something
again (`rep_add`, `client_create`, `client_invite`, `gk_record_upsert`,
`marketing_refresh`). `client_invite` alone is `openWorldHint: true`: it emails
someone outside NPSA.

Each write is logged on the server after it runs, as

```
[mcp] write <tool> by <name or key fingerprint> args=[<argument names>] ok
[mcp] write <tool> by <name or key fingerprint> args=[<argument names>] error: <message>
```

The argument names only, never their values: those carry client emails, phones, EINs
and record contents. Emails and long digit runs in an error message are masked, and
the message is cut at 200 characters. The route's own log line (`[intake] client_update
<slug> by <actor>`, `[gk] update …`) names what was touched.

When a route refuses a call, the tool error carries the route's message and, on a
`Details:` line, the rest of its JSON (a 409's current record, a refused seed's
`unknown_keys`), capped at 2,000 characters.

| Tool | What it changes |
| :--- | :--- |
| `letter_update` | Client name, rep name and/or fee total on a saved letter. Content untouched. |
| `rep_add` | Adds a sales rep |
| `rep_remove` | Removes a sales rep (destructive) |
| `marketing_booking_update` | Held, became-client, exclusion reason, channel or campaign override on one booking. Same overrides as the dashboard toggles. |
| `marketing_refresh` | Re-enriches bookings, like the dashboard's "Refresh data" |
| `client_create` | Registers a grant client and mints their intake link |
| `client_update` | Fields, phase, status, contacts, applications and documents on a client |
| `client_invite` | Emails one of the client's contacts their intake link, as their grant writer (`PATCH /api/clients/:slug` with `invite_contact_email`) |
| `intake_seed` | Writes intake answers; an unknown key fails the whole call by name |
| `client_token_rotate` | Re-issues the intake link (destructive: the old one dies) |
| `gk_record_upsert` | Adds or changes any kind of knowledge record; lands unverified; needs a source or a stated reason; version-checked. A field the kind does not have is refused with the list of fields it does have |
| `gk_mark_verified` | Marks a record verified in the user's name (or takes it back). Never on Claude's own research |
| `gk_record_archive` | Takes a record out of view, or restores it. Nothing is deleted |
| `gk_revert` | Puts a record back to before one revision, as a new revision |

Not exposed on purpose: creating or deleting letters (the generator owns the form
data shape), the ingest and reconcile endpoints (those belong to the Zaps), and the
Calendly backfill.

## How it is built

- **Stateless Streamable HTTP.** Each POST builds a fresh `McpServer` and transport,
  answers, and discards them. No session table, nothing to leak between callers,
  nothing to break when Railway restarts the container. `GET` and `DELETE` on
  `/mcp` return 405 for that reason.
- **Tools call the existing routes over loopback** (`http://127.0.0.1:PORT/api/...`)
  rather than re-implementing their SQL. The marketing queries live inline in their
  handlers; a second copy here would drift from the dashboard. Going through the
  route means the number Claude reads is the number on the screen, and a write
  lands the way the UI's own button would land it (the booking PATCH re-enriches).
  The one exception is `precall_booking_get` (no route exists; it calls
  `getBooking`). The grant-client routes are keyed; the
  loopback calls present the key the process minted at boot (`X-Internal-Key`) and the
  caller's fingerprint (`X-Actor`), so the route's log line names the same person the
  MCP audit line does. See [grant-clients.md](grant-clients.md).
- **Errors come back as tool errors**, not protocol failures. "Storage not
  configured" or "Calendly is not connected" reach Claude as text it can act on.
- **Fail closed.** No `MCP_API_KEYS`, no service. Keys are compared with
  `timingSafeEqual`.

## Checking it

```bash
node scripts/mcp-smoke.mjs
```

Runs with no database or network: stands up the MCP layer against fake `/api`
routes and checks the gate (503 / 401 / 405 / accepted), the protocol (a real SDK
client lists and calls tools), the plumbing (loopback reads, `saved_html` omission,
the `clients_list` slim view, `marketing_breakdown` routing, upstream errors and
their capped details surfacing as tool errors), the writes (the exact tool set,
annotations and confirm wording, method and body forwarded per tool, the audit line
with argument names and outcome but no values, and `MCP_WRITE_KEYS` hiding the write
tools from a read-only key), the grant-client tools (internal key and fingerprint on
the loopback call, shapes per tool, `client_invite` forwarding, an unknown-key seed
refusal surfacing by name), and the grant knowledge tools against the real routes on
an in-memory store (including the `gk_revisions` limit on one record).

## What comes next

The end goal is to move grant-writing client management, today in the Google Apps
Script intake app, into this backend and drive it through the MCP. Version one is
read-only so the connection and the shape of the tools can be proven first. The
follow-up, in order:

1. ~~**Write tools with confirmation.**~~ Done: the write tools above.
2. ~~**Grant clients module.**~~ Tables, routes and the twelve tools above are in; the
   client page, the import from the Apps Script registry and uploads follow, per
   [grant-clients.md](grant-clients.md).
3. **Per-user identity.** Partly done: `MCP_KEY_NAMES` names the holder of each key
   and `ACTOR_PROXY_KEYS` lets the toolbox pass the logged-in person through, which
   is what the grant knowledge edit history records. Moving to OAuth against the
   auth service is still open; claude.ai and Cowork already connect with a bearer
   header (above).
