# Marketing Dashboard — Install Guide

Everything is additive. Nothing here changes the LOE tool, the Sheet, or the live site
until you deliberately merge the branch. Work on `feature/marketing-dashboard`.

You (or Claude Code) are dropping in **3 new files** and making **3 tiny edits**.

## New files (copy as-is into the repo)
```
server/marketing.js
src/marketing/MarketingDashboard.jsx
scripts/backfill-bookings.js
```

## Edit 1 — server/index.js (2 lines)
Add near the other imports at the top:
```js
import { registerMarketing } from './marketing.js';
```
Then, **just above** the SPA fallback (`app.get('*', ...)` near the bottom), add:
```js
registerMarketing(app, pool);
```
That's the entire backend wiring. The `bookings` table auto-creates on boot, exactly like `letters`.

## Edit 2 — src/App.jsx (import + one render line)
Add with the other imports at the top:
```js
import MarketingDashboard from './marketing/MarketingDashboard.jsx';
```
Inside the top-level `return ( <> ... </> )` (where the other `appView === '...'` blocks are), add:
```jsx
{appView === 'marketing' && <MarketingDashboard onBack={() => setAppView('dashboard')} />}
```

## Edit 3 — src/App.jsx (let the sidebar deep-link to it)
Add this near the other `useEffect`s so a link like `/?view=marketing` opens the page:
```js
useEffect(() => {
  if (new URLSearchParams(window.location.search).get('view') === 'marketing') setAppView('marketing');
}, []);
```
The sidebar "Marketing" tab (in whichever repo owns the left nav) just points at `…/?view=marketing`.
Optional: to reach it from inside this app too, add a card on the Sales Toolbox dashboard with
`onClick={() => setAppView('marketing')}`.

---

## Environment variables (Railway → Variables)
```
ZAPIER_WEBHOOK_SECRET   # any long random string; also used by the Zap + backfill
INSTANTLY_API_KEY       # optional — enables reverse-match; UTM attribution works without it
CALENDLY_API_TOKEN      # optional — enables auto "Held" status; manual toggle works without it
```
Nothing breaks if the two optional keys are missing — those rows just stay unenriched.

---

## Salesforce connector (keeps the Sales half current on its own)

The dashboard pulls Salesforce itself, on a schedule, from inside this app. Every run asks
Salesforce for the complete current set of won opportunities and grant applications, upserts
them, and deletes anything Salesforce no longer has — so the figures can't drift in either
direction, and nobody has to re-run a backfill by hand.

Without these variables the connector stays idle and everything else works exactly as before.

```
SF_CLIENT_ID              # External Client App consumer key
SF_USERNAME               # Salesforce username the sync runs as
SF_PRIVATE_KEY            # RSA private key, PEM (literal newlines or \n both work)
SF_LOGIN_URL              # optional — https://test.salesforce.com for a sandbox
SF_API_VERSION            # optional — default v60.0
SF_WON_STAGE              # optional — default 'Won - Data Migrated to 2012 Processes'
SF_WINS_SINCE             # optional — default 2024-10-01
SF_SYNC_INTERVAL_MINUTES  # optional — default 360 (every 6 hours)
```

### Why this uses JWT and not a refresh token

Salesforce no longer lets you create a classic Connected App in App Manager, and new
External Client Apps come with **Enable Refresh Token Rotation** checked and locked
("to change this required setting, contact Support"). Rotation invalidates the old
refresh token every time a new access token is issued, so a refresh token parked in an
env var authenticates once and then fails silently on the next scheduled run — six hours
later, in a background job nobody is watching.

The JWT bearer flow has no refresh token to rotate. The server signs a short-lived
assertion with a private key and trades it for an access token whenever it needs one.
Salesforce holds only the matching public certificate. Nothing expires on a timer,
so there is no credential to re-mint by hand later.

### 1. Create the External Client App

Salesforce **Setup → External Client App Manager → New External Client App**:
- Name: `NPSA Dashboard Sync`
- Contact email: yours
- Under **API (Enable OAuth Settings)**, check **Enable OAuth**
- Callback URL: `https://login.salesforce.com/services/oauth2/success`
  (unused by JWT, but the form requires one)
- Selected OAuth Scopes: **Manage user data via APIs (api)** and
  **Perform requests at any time (refresh_token, offline_access)**
- Under **Flow Enablement**, check **Enable JWT Bearer Flow**
- Save, then **Consumer Key and Secret** to copy the Consumer Key. The secret is not
  needed for this flow — JWT never sends one.

Salesforce takes up to ~10 minutes to propagate a new app.

### 2. Generate the key pair and upload the certificate

Run locally. The private key never leaves your machine except to go into Railway;
Salesforce only ever sees the `.crt`.

```bash
openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 \
  -keyout npsa-sync.key -out npsa-sync.crt \
  -subj "/CN=NPSA Dashboard Sync"
```

In the External Client App → **Settings → OAuth Settings → Digital Signatures**, check
**Use digital signatures** and upload `npsa-sync.crt`. Save.

Keep `npsa-sync.key` somewhere safe and out of git. It is the whole credential.

### 3. Pre-authorize the user

JWT bearer will not mint a token for a user who has not approved the app, and there is
no interactive approval step in a background job. So authorize it up front:

- External Client App → **Policies → OAuth Policies → Permitted Users** →
  **Admin approved users are pre-authorized**
- Then assign the app via a permission set or profile to the user in `SF_USERNAME`

While you are on that screen, set **IP Relaxation** to **Relax IP restrictions**.
Railway's outbound IPs are dynamic, so enforcing them will fail intermittently and
look like an auth bug.

### 4. Set the variables in Railway and verify

Paste the full contents of `npsa-sync.key` into `SF_PRIVATE_KEY`, including the
`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.

```bash
# force a run rather than waiting for the schedule
curl -X POST https://<your-railway-domain>/api/marketing/sync/salesforce \
  -H "x-zap-secret: <ZAPIER_WEBHOOK_SECRET>"

# what the dashboard's freshness strip reads
curl https://<your-railway-domain>/api/marketing/sync/status
```

The Sales section shows the result as a line under its heading — when it last synced, how many
records, and any failure. If it went wrong, that strip says so rather than quietly showing
yesterday's numbers.

**Reading auth failures.** Salesforce's JWT errors are terse and all look alike:
- `user hasn't approved this consumer` — step 3 was skipped, or the permission set is
  not assigned to `SF_USERNAME`
- `invalid_app_access` — the app is not assigned to that user's profile
- `invalid_grant` with a valid key — usually `aud` vs org mismatch: a sandbox needs
  `SF_LOGIN_URL=https://test.salesforce.com`
- `JWT signing failed` in `sync_runs.error` — the connector caught a malformed
  `SF_PRIVATE_KEY` before ever calling Salesforce, so this one is a paste problem

### Safety rails
The sync deletes, so it refuses when the pull looks wrong rather than trusting it:
- a query returning **zero** records is treated as a broken query or permissions change, not as
  an empty Salesforce — nothing is deleted
- a pull that would remove **more than half** the stored rows is held back and flagged on the
  freshness strip; the upserts still land
- every attempt, successful or not, writes a `sync_runs` row

---

## Wire the Zap (adds bookings to Postgres in real time)
In your existing Calendly → Google Sheets Zap, add ONE action after the trigger:
- App: **Webhooks by Zapier → POST**
- URL: `https://<your-railway-domain>/api/marketing/bookings/ingest`
- Headers: `x-zap-secret: <ZAPIER_WEBHOOK_SECRET>`
- Data (map from the Calendly trigger — same fields you already send to the Sheet, plus the two URIs):
  ```
  calendly_uri  = Invitee URI
  event_uri     = Scheduled Event URI
  booked_on     = Invitee Created At
  meeting_date  = Scheduled Event Start Time
  name          = Invitee Name
  email         = Invitee Email
  organization  = <the Organization question answer>
  told_us       = <the "How did you hear" answer>
  utm_source    = Tracking UTM Source
  utm_medium    = Tracking UTM Medium
  utm_campaign  = Tracking UTM Campaign
  host          = Scheduled Event Hosts Email
  ```
The Sheet step stays exactly as-is. This just adds a parallel write.

---

## One-time backfill of existing bookings
Publish the Sheet as CSV (File → Share → Publish to web → CSV), then with the server running:
```bash
SHEET_CSV_URL="https://docs.google.com/.../pub?output=csv" \
ZAPIER_WEBHOOK_SECRET="<same secret>" \
node scripts/backfill-bookings.js
```

---

## Verify (quick smoke test)
1. `npm run build` succeeds.
2. Start the server. Hit `POST /api/marketing/bookings/ingest` with a test body (curl below) → returns `{ ok, id }`.
3. Open the app at `/?view=marketing` → KPI cards, funnel, and the bookings table render.
4. `POST /api/marketing/enrich` → check a UTM-tagged row shows its campaign, and a booking whose org has an engagement letter shows **Became Client** + fee.

```bash
curl -X POST http://localhost:3001/api/marketing/bookings/ingest \
  -H "Content-Type: application/json" -H "x-zap-secret: <secret>" \
  -d '{"name":"Test Person","email":"t@example.com","organization":"Test Church",
       "meeting_date":"2026-08-01T16:00:00Z","utm_source":"instantly",
       "utm_campaign":"tx-nsgp-church","told_us":"Email from Nonprofit Security Advisors"}'
```

---

## What to hand your dev
The whole `marketing-build/` folder + this guide + the Build Brief. The only thing outside
this repo is the sidebar nav link (Edit 3's `/?view=marketing`), which is a one-line change in
the shell that renders the left navigation.
```
