# Redesign parity audit

Checked line-by-line against the live apps before the redesign ships:

- Marketing dashboard — `origin/loe-generator:src/marketing/MarketingDashboard.jsx`
- Sales Toolbox dashboard — `origin/loe-generator:src/App.jsx` (`appView === 'dashboard'` and `'settings'`)

Every element below exists in the live app today. "Where" is where it now lives
in this Next.js app.

> **Note:** the live Sales Toolbox app moves fast. This was re-audited against
> `origin/loe-generator` at `b2fe15c`, which added the whole Sales /
> applications section. Re-check before the next big change.

## Sales — grant applications & contracts

| Live element | Where it is now |
|---|---|
| Salesforce sync status line | Sales band, above the cards (hidden if the backend has no `sync/status`) |
| Organizations won + contracts signed | Sales band, key-figure card |
| Contract value | Sales band, key-figure card (figure in olive) |
| Grant applications (preparing / submitted) | Sales band, key-figure card |
| Awarded to clients | Grant dollars row |
| Pending award | Grant dollars row |
| Acceptance rate + % of ask funded | Grant dollars row |
| Show breakdown by grant program | Collapsible program table |
| New organizations won over time | Sales trend chart |
| — month / quarter granularity | Sales trend chart |
| — New orgs / Contract $ / Contracts | Sales trend chart |
| — Show cumulative growth | Sales trend chart |

## Marketing dashboard

| Live element | Where it is now | Notes |
|---|---|---|
| "Refresh data" (POST `/api/marketing/enrich`) | "Refresh data" button in the page header | Re-fetches everything on success |
| Title + subtitle | Eyebrow + "The business, up front." | |
| "Funnel tracked since Feb 2026" badge | In the *Marketing* section's subtitle, not the page headline | Applies to the funnel, not the Salesforce figures above it |
| KPI — bookings this week | Pulse strip | Fixed window; doesn't move with the range chips |
| KPI — bookings this month (+ MoM) | Pulse strip | Shows `+N vs last month` |
| KPI — LOE sent (`client_rate`, % of bookings) | Funnel row *LOE sent* (`% of booked`) | Same measure; the KPI tile shows the range-scoped count |
| KPI — from Instantly (`instantly_pct`) | Pulse strip | |
| KPI — LOE value (`total_fees_won`) | Pulse strip, figure in olive | |
| Salesforce — total won revenue + win count | Sales band, *contract value* card | Was duplicated in a second band; the two showed the same figure |
| Salesforce — untracked / pre-funnel + deal count + list | Disclosure inside *contract value* | "$X closed before the funnel · show N deals" |
| ~~Attribution coverage meter~~ | Removed | Dropped at Stuart's request — a comparable funnel predates the round-robin, so the figure misleads |
| ~~Attributed-to-funnel card~~ | Removed | Same attribution framing as the meter above |
| Funnel — Booked / Held / LOE Sent / Won + % of booked | Funnel card | |
| Funnel — "$X in LOE value" footer | Funnel card, LOE sent row | Range-scoped from bookings; all-time uses `funnel.fees` |
| Funnel — "$X in revenue" footer | Funnel card, Won row | |
| Chart — metric toggle (Bookings/Held/LOEs/Won $) | Time-series card | |
| Chart — week / month granularity | Time-series card | Monthly series fetched on demand |
| Chart — compare previous period (ghost bars) | Time-series card | |
| Chart — window stepper ‹ › + range label | Time-series card | |
| Chart — gridlines, baseline, ~7 spaced x labels | Time-series card | |
| By channel — booked + LOE count | Channels card | Also shows won $ |
| By campaign & source — campaign, booked bar, held, LOEs, LOE $ | Campaign table | |
| Bookings — search by name / org / email | Bookings table | Debounced; searches server-side |
| Bookings — org/name, channel, campaign, meeting date | Bookings table | |
| Bookings — Held and LOE checkboxes (PATCH) | Bookings table | Optimistic, rolls back on failure |
| Bookings — who took the meeting | Bookings table, under the meeting date | Email local-part, title-cased |
| Bookings — exclusion reason (unqualified / double booking / cancelled) | Bookings table, "Counts?" column | Quiet until hovered or set; excluded rows read as set aside |
| Bookings — Calendly cancellation | Bookings table | Stated as a badge, not offered as a choice |
| "Excluded from these figures: N cancelled · N double booking (N this week)" | Under the *marketing* heading, with the figures it qualifies | |

Added, not in the live app: range chips (30d / 90d / YTD / All, remembered
between visits), and an editable **channel** on each booking row — the backend's
PATCH has accepted `channel` since #93, but the live table still renders it
read-only.

Section order: sales (Salesforce) → marketing KPIs → bookings chart → raw
bookings → funnel + channels → campaign & source. Raw rows come before every
roll-up that summarises them, following upstream `62b59dc`. The scraper strip was removed from this page —
the Scraper tab owns that.

## Bookings page

The raw bookings table also has its own page, `/bookings`, in the sidebar, for the
people who work through attribution every day. It is the same `BookingsTable`,
with the same range (shared with the Dashboard) and the same server-side search,
plus filters for the recurring work:

| Filter | Shows |
|---|---|
| Needs attribution | No channel, the Direct / Other catch-all, or Instantly with no campaign. Set-aside and cancelled bookings are left out |
| Held, no LOE yet | Meetings marked held where no LOE has gone out |
| Upcoming | Meetings still to come |

Where a campaign is expected and missing, the Campaign cell reads "Find the
campaign" instead of a dash; clicking it opens the same Instantly picker. The
Dashboard's table links to the page.

## Sales Toolbox

| Live element | Where it is now |
|---|---|
| Generate New Letter | "Generate a new letter" (the navy card) |
| Load Previous Letter | "Open a saved letter" |
| Total Letters Generated | KPI tile |
| Total Fees Generated | KPI tile, "Fees in saved letters" (figure in olive) |
| Rep Leaderboard | Leaderboard card — every rep, no truncation |
| New Proposal | "New proposal" |
| New Addendum | "New addendum" |
| Pre-Call Notes Generator (Beta) | "Pre-call notes" |
| Settings → Sales Reps (gear icon) | "Sales reps", under Settings |

The cards deep-link with `?view=…`, which `/loe` forwards to the Sales Toolbox
iframe. Each one opens its tool directly:

| `?view=` | Opens |
|---|---|
| `generator` / `proposal` / `addendum` | the generator, on that document tab, with a fresh form |
| `letters` | the saved-letters browser |
| `precall` | the pre-call notes generator |
| `settings` | Sales Reps |
| `marketing` | the embedded marketing dashboard (used by `/marketing`) |

An unrecognised value lands on the Sales Toolbox's own dashboard, as before.

Because a deep link skips that dashboard on the way in, the tool's
"← Dashboard" shouldn't reveal it on the way out — it posts
`{type:'npsa:navigate'}` to the shell, and `ToolFrame` routes to `/toolbox`
(or `/` from `/marketing`). Opened directly on Railway, with no shell and no
deep link, back still goes to the app's own dashboard, so it stays usable
standalone.

> Requires the matching `loe-generator` change (PR #97). Without it the deep
> links fall through to that app's dashboard and you land on it twice.

## Known gaps (deliberate)

- **"Signed" funnel stage** — the live funnel has four stages and so does this
  one. A fifth "Signed" stage would need a new column on `bookings`; dropped by
  agreement rather than inventing data.
- **Channel / campaign figures over very long ranges** — these are derived from
  `/api/marketing/bookings`, which the backend caps at 500 rows. The card says
  so when the cap is hit. Counts, rates and won revenue come from the
  aggregated time series and are never capped.
- **LOE generator wizard** — not built here; it belongs to the `loe-generator`
  app. See PR #95 for why.
- **`/api/marketing/sync/status`** — implemented in
  `server/connectors/salesforce.js` (`registerSalesforceConnector`), not in
  `server/marketing.js` where the other marketing routes live. Railway
  auto-deploys the `loe-generator` branch, so nothing is out of sync. The
  dashboard's sync line still tolerates a missing endpoint, which keeps it safe
  against older deploys.
