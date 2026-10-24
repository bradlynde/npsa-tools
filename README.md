# NPSA Auth Service

Centralized authentication for NPSA tools (School Scraper, Church Scraper, LOE
Generator, the toolbox).

Login is **passwordless**. You enter an email; if it belongs to someone here, a
six-digit code is sent to it; you exchange the code for a JWT. There is no
password to store, leak, rotate, or read out over the phone.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/request-code` | `{ email }` → emails a code. **Always returns 200.** |
| POST | `/auth/verify-code` | `{ email, code }` → `{ status, token, username }` |
| POST | `/auth/refresh` | `{ token }` → a fresh `{ status, token, username }`, or 401 if it lapsed or the session is past its maximum age |
| GET | `/health` | Health check |

`/auth/request-code` answers identically, and in the same time, whether the
address is known, throttled, or undeliverable: everything that depends on the
address (looking it up, minting the code, calling Resend) runs after the
response has been sent. An unauthenticated caller does not get to discover who
works here — the reasons are in the logs, not the response.

Codes are six digits, valid for **10 minutes**, usable **once**, and allow **5
guesses** before they die. Only a bcrypt hash of the code is stored. Requesting
a new code retires the previous one.

Throttles, per address and enforced in Postgres so they survive restarts:

- one code per minute and five per hour;
- at most `AUTH_MAX_FAILED_VERIFIES` (default 15) wrong codes in a rolling 24
  hours, across all codes. Past that, request-code sends nothing and
  verify-code refuses every code for the address, with the same responses as
  any other failure, until the oldest failures age out. Each refusal logs a
  WARNING starting `SECURITY-ALERT sign-in locked` — alert on it, and check
  with the person before unlocking them early:
  `DELETE FROM login_failures WHERE email = 'name@example.com';`

There are also best-effort in-process per-IP caps, counted separately for
request-code and verify-code. The toolbox and the LOE app call this service
from their own servers, so many people share an IP here; the per-address limits
are what protect an account.

## Setup

1. `JWT_SECRET` — shared with every backend that verifies tokens. **Changing it
   signs everyone out and breaks the scrapers and LOE proxy until they match.**
2. `DATABASE_URL` — Railway Postgres.
3. `RESEND_API_KEY` — a **Sending access** key, not full access.
4. `AUTH_EMAIL_FROM` — must be on a domain verified in Resend.
5. `JWT_EXPIRATION_HOURS` — how long a sign-in lasts without use (default 336,
   14 days). The toolbox renews the token through `/auth/refresh` while someone
   uses it, so active people stay signed in and only an idle sign-in lapses.
6. `AUTH_MAX_SESSION_DAYS` — how long renewal can keep one sign-in going
   (default 30). See [Token lifetime](#token-lifetime).
7. `AUTH_MAX_FAILED_VERIFIES` — wrong codes allowed per address per 24 hours
   before it is locked (default 15).
8. `CORS_ORIGINS` — comma-separated. The toolbox proxies login server-side, so
   this only matters for direct browser calls.

Without `RESEND_API_KEY` nothing is sent, and the code is **not** logged. For
local development, also set `AUTH_DEV_LOG_CODES=1` and the code is written to
the log instead. Never set that in production.

`init_db()` runs on startup. It is idempotent, and it migrates an older
deployment in place: adds the `email` column, drops the old `password_hash`
column if it is still there, creates `login_codes` and `login_failures`, and
reconciles the seed list.

## Adding or removing people

Edit `SEED_USERS` in `database.py` and redeploy. Each entry is
`(username, email)`:

- `username` goes into the JWT and is what the rest of the toolbox knows people
  by, including the letter leaderboard. **Don't change an existing one.**
- `email` is the login identity and can be updated freely — on redeploy the
  address is reattached to that username.

Removing someone means deleting their row; taking them out of `SEED_USERS`
alone does not (nothing here deletes users, on purpose).

## Passwords are gone

There is no password route and no password check. The only way in is to receive
mail at an address in `SEED_USERS`.

The old `password_hash` column has been dropped: `init_db()` removes it on
startup if a database still has it. There is no password fallback to revert to.

### A note on the old passwords

Until recently the seed list held plaintext passwords in this repository —
`admin`, and `user1` through `user6`. They are in git history and cannot be
removed from it. Treat them as permanently compromised: they must not be reused
on any other system.

### The other login

The school-scraper service used to expose its own `/login`, backed by an
`AUTH_USERS` environment variable, minting tokens with the same shared secret —
a second way into the toolbox that this service could not close. That route has
been removed; the scraper now only verifies tokens issued here. If an
`AUTH_USERS` variable is still set on any Railway service, it is dead config and
should be deleted.

## Token lifetime

Every token carries `username`, `exp`, `iat` and `auth_time` (when the person
last entered an emailed code). Consumers only need `username` and `exp`; the
others are for this service.

- `JWT_EXPIRATION_HOURS` (default **336**, 14 days) is the idle window: each
  token lasts this long, and the toolbox swaps it for a fresh one while in use.
  The frontend reads `exp` from the token itself, so there is no second setting
  to keep in step.
- `AUTH_MAX_SESSION_DAYS` (default **30**) caps how long renewal can stretch a
  single sign-in. `/auth/refresh` carries `auth_time` forward, never issues a
  token that outlives `auth_time` + this, and answers 401 once it has passed,
  so everyone types a fresh code at least this often.
- Tokens issued before `auth_time` existed are not refused: on their first
  refresh they get an `auth_time` taken from their `iat` (or the current time
  if they have none), and the limit applies from then on.
