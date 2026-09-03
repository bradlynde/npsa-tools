# MCP server

The Sales Toolbox backend exposes its data to Claude through the Model Context
Protocol at `POST /mcp` on the Railway service (the `loe-generator` lineage). Claude
Code and Claude Desktop connect to it directly and get tools for letters, reps,
NSGP deadlines, pre-call bookings, the marketing dashboard figures, and the in-house
grant clients with their intake forms -- twenty-one reads, and eleven writes for keys
allowed them.

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

3. Redeploy. Confirm with:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://loe-generator-production.up.railway.app/mcp
   ```

   `401` means it is live and gated. `503` means the variable is not set. `200`
   with HTML means the deploy has not picked up the route yet.

Keys are secrets. Do not commit them -- `.mcp.json` carries `${NPSA_MCP_KEY}`
rather than a key for exactly that reason -- and do not keep them under
`~/Documents` (iCloud-synced).

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

Desktop's built-in "custom connector" flow only speaks OAuth, so a bearer-key server
goes in through the `mcp-remote` bridge instead. In
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

Not supported by this version. Those connectors require OAuth 2.1 with dynamic
client registration, which means an authorization server in front of the existing
login-code auth service. Scoped separately if it is wanted. Note this is a separate
thing from Claude Code on the web above, which is a Claude Code client and reads
`.mcp.json` like any other.

## Tools

Dollar figures USD, dates ISO, states two-letter. Read tools first, then writes.

| Tool | What it answers |
| :--- | :--- |
| `letters_stats` | Engagement-letter count, total fees, per-rep leaderboard |
| `letters_search` | Saved letters/proposals/addendums, filter by name or type |
| `letter_get` | One letter's form data and fee (HTML on request) |
| `reps_list` | Sales reps |
| `letter_template_get` | Template definition for a document type |
| `nsgp_deadlines_list` | Curated NSGP deadlines, by state, upcoming only |
| `nsgp_state_reference` | SAA, state-funded programs, last verified, per state |
| `precall_bookings_list` | Upcoming Calendly consultations with pre-call facts |
| `precall_booking_get` | One booking by event URI |
| `marketing_overview` | Stats, funnel, application stats, Salesforce sync status |
| `marketing_by_campaign` | Funnel grouped by Instantly campaign |
| `marketing_by_channel` | Funnel grouped by channel |
| `marketing_timeseries` | Bookings by week/month, or sales by month/quarter |
| `marketing_bookings` | Individual booking rows with attribution |
| `marketing_untracked_wins` | Wins with no matching booking |
| `marketing_revenue_quality` | Reconciliation of the two revenue totals |
| `clients_list` | In-house grant clients with phase, status, intake link, counts and quiet clock |
| `client_get` | One client's record, contacts and headline intake counts |
| `intake_questions` | The intake form's key catalog; look keys up here before seeding |
| `intake_answers` | A client's intake answers in form order, filterable by section |
| `intake_status` | Per-section counts, the 24 checklist tasks, submission stamp, uploads |

### Write tools

Every write tool's description starts with `WRITE` and tells Claude to confirm the
exact change with the person before calling it. The MCP annotations say the same
(`readOnlyHint: false`, and `destructiveHint: true` on the two deletes) for clients
that read them. Each write is logged on the server as
`[mcp] write <tool> by <key fingerprint> <arguments>`, which is the audit trail
until keys map to people.

| Tool | What it changes |
| :--- | :--- |
| `letter_update` | Client name, rep name and/or fee total on a saved letter. Content untouched. |
| `rep_add` | Adds a sales rep |
| `rep_remove` | Removes a sales rep (destructive) |
| `nsgp_deadline_upsert` | Adds or updates the deadline for a state + program + cycle year. Row becomes manually maintained. |
| `nsgp_deadline_delete` | Deletes one deadline row (destructive) |
| `marketing_booking_update` | Held, became-client, exclusion reason, channel or campaign override on one booking. Same overrides as the dashboard toggles. |
| `marketing_refresh` | Re-enriches bookings, like the dashboard's "Refresh data" |
| `client_create` | Registers a grant client and mints their intake link |
| `client_update` | Fields, phase, status and contacts on a client |
| `intake_seed` | Writes intake answers; an unknown key fails the whole call by name |
| `client_token_rotate` | Re-issues the intake link (destructive: the old one dies) |

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
  lands the way the UI's own button would land it (the booking PATCH re-enriches,
  the deadline PUT marks the row manual). The two exceptions are
  `nsgp_state_reference` (static data, imported directly) and `precall_booking_get`
  (no route exists; it calls `getBooking`). The grant-client routes are keyed; the
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
client lists and calls tools), the plumbing (loopback reads, deadline filtering,
`saved_html` omission, upstream errors surfacing as tool errors), the writes
(annotations and confirm wording, method and body forwarded per tool, the audit
line, and `MCP_WRITE_KEYS` hiding the write tools from a read-only key), and the
grant-client tools (internal key and fingerprint on the loopback call, shapes per
tool, an unknown-key seed refusal surfacing by name).

## What comes next

The end goal is to move grant-writing client management, today in the Google Apps
Script intake app, into this backend and drive it through the MCP. Version one is
read-only so the connection and the shape of the tools can be proven first. The
follow-up, in order:

1. ~~**Write tools with confirmation.**~~ Done: the write tools above.
2. ~~**Grant clients module.**~~ Tables, routes and the nine tools above are in; the
   client page, the import from the Apps Script registry and uploads follow, per
   [grant-clients.md](grant-clients.md).
3. **Per-user identity.** Once writes exist it matters who made them. Either tie each
   key to a user record, or move to OAuth against the auth service, which also
   unlocks claude.ai and Cowork connectors.
