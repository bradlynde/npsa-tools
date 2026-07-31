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
| Organizations won + contracts signed | Sales band, olive hero |
| Contract value | Sales band, navy |
| Grant applications (preparing / submitted) | Sales band, navy |
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
| "Refresh data" (POST `/api/marketing/enrich`) | `↻ refresh data` in the page header | Re-fetches everything on success |
| Title + subtitle | Eyebrow + "The business, up front." | |
| "Funnel tracked since Feb 2026" badge | Badge under the headline | |
| KPI — bookings this week | Pulse strip | Fixed window; doesn't move with the range chips |
| KPI — bookings this month (+ MoM) | Pulse strip | Shows `+N vs last month` |
| KPI — LOE sent (`client_rate`, % of bookings) | Funnel row *LOE sent* (`% of booked`) | Same measure; the KPI tile shows the range-scoped count |
| KPI — from Instantly (`instantly_pct`) | Pulse strip | |
| KPI — LOE value (`total_fees_won`) | Pulse strip, olive | |
| Salesforce — total won revenue + win count | Salesforce band, navy hero card | |
| Salesforce — attributed to funnel + coverage % + count | Salesforce band | |
| Salesforce — untracked / pre-funnel + deal count | Salesforce band | |
| Salesforce — show/hide untracked list (org, closed, amount) | Collapsible table in the band | Lazy-loads `untracked-wins` |
| ~~Attribution coverage meter~~ | Removed | Dropped at Stuart's request — a comparable funnel predates the round-robin, so the figure misleads. May return in his own session |
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

Added, not in the live app: range chips (30d / 90d / YTD / All, remembered
between visits).

Ordering follows the live app: the bookings table sits **above** the campaign
roll-up (upstream `62b59dc`). The scraper strip was removed from this page —
the Scraper tab owns that.

## Sales Toolbox

| Live element | Where it is now |
|---|---|
| Generate New Letter | Card **i** |
| Load Previous Letter | Card **ii** |
| Total Letters Generated | KPI tile |
| Total Fees Generated | KPI tile (olive) |
| Rep Leaderboard | Leaderboard card — every rep, no truncation |
| New Proposal | Card **iii** |
| New Addendum | Card **iv** |
| Pre-Call Notes Generator (Beta) | Card **v** |
| Settings → Sales Reps (gear icon) | Card **vi**, "Manage Sales Reps" |

The cards deep-link with `?view=…`, which `/loe` forwards to the Sales Toolbox
iframe. That app currently honours `view=marketing` and lands on its dashboard
for anything else, so the links are safe today and become direct the moment it
adds support.

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
