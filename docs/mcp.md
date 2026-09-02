# MCP server

The Sales Toolbox backend exposes its data to Claude through the Model Context
Protocol at `POST /mcp` on the Railway service (the `loe-generator` lineage). Claude
Code and Claude Desktop connect to it directly and get read-only tools for letters,
reps, NSGP deadlines, pre-call bookings and the marketing dashboard figures.

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

3. Redeploy. Confirm with:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://loe-generator-production.up.railway.app/mcp
   ```

   `401` means it is live and gated. `503` means the variable is not set. `200`
   with HTML means the deploy has not picked up the route yet.

Keys are secrets. Do not commit them and do not keep them under `~/Documents`
(iCloud-synced).

## Connecting

### Claude Code

```bash
claude mcp add --transport http npsa-tools https://loe-generator-production.up.railway.app/mcp --header "Authorization: Bearer YOUR_KEY"
```

Add `--scope user` to make it available in every project rather than just the
current one. Then `/mcp` inside Claude Code shows the server and its tools.

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

### claude.ai web and Cowork

Not supported by this version. Those connectors require OAuth 2.1 with dynamic
client registration, which means an authorization server in front of the existing
login-code auth service. Scoped separately if it is wanted.

## Tools

All read-only. Dollar figures USD, dates ISO, states two-letter.

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

## How it is built

- **Stateless Streamable HTTP.** Each POST builds a fresh `McpServer` and transport,
  answers, and discards them. No session table, nothing to leak between callers,
  nothing to break when Railway restarts the container. `GET` and `DELETE` on
  `/mcp` return 405 for that reason.
- **Tools call the existing routes over loopback** (`http://127.0.0.1:PORT/api/...`)
  rather than re-implementing their SQL. The marketing queries live inline in their
  handlers; a second copy here would drift from the dashboard. Going through the
  route means the number Claude reads is the number on the screen. The two
  exceptions are `nsgp_state_reference` (static data, imported directly) and
  `precall_booking_get` (no route exists; it calls `getBooking`).
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
client lists and calls tools), and the plumbing (loopback reads, deadline filtering,
`saved_html` omission, upstream errors surfacing as tool errors).

## What comes next

The end goal is to move grant-writing client management, today in the Google Apps
Script intake app, into this backend and drive it through the MCP. Version one is
read-only so the connection and the shape of the tools can be proven first. The
follow-up, in order:

1. **Write tools with confirmation.** Save/update letters, edit deadlines, toggle
   a booking's Held/LOE flags. Each tool's description tells Claude to confirm with
   the user before calling it.
2. **Grant clients module.** New tables (`clients`, `intake_answers`, `intake_uploads`)
   and routes mirroring what the Apps Script registry does today: register a client,
   mint a tokenised intake link, seed intake questions, read answers as they land.
   Then MCP tools on top: `client_create`, `client_get`, `intake_seed`,
   `intake_answers`, `intake_status`.
3. **Per-user identity.** Once writes exist it matters who made them. Either tie each
   key to a user record, or move to OAuth against the auth service, which also
   unlocks claude.ai and Cowork connectors.
