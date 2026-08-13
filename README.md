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
| POST | `/login` | Legacy password login. Deprecated — see *Retiring passwords*. |
| GET | `/health` | Health check |

`/auth/request-code` answers identically whether the address is known,
throttled, or undeliverable. An unauthenticated caller does not get to discover
who works here — the reasons are in the logs, not the response.

Codes are six digits, valid for **10 minutes**, usable **once**, and allow **5
guesses** before they die. Only a bcrypt hash of the code is stored. Requesting
a new code retires the previous one.

Throttles: one code per address per minute and five per hour (enforced in
Postgres, so they survive restarts), plus a best-effort in-process per-IP cap.

## Setup

1. `JWT_SECRET` — shared with every backend that verifies tokens. **Changing it
   signs everyone out and breaks the scrapers and LOE proxy until they match.**
2. `DATABASE_URL` — Railway Postgres.
3. `RESEND_API_KEY` — a **Sending access** key, not full access.
4. `AUTH_EMAIL_FROM` — must be on a domain verified in Resend.
5. `CORS_ORIGINS` — comma-separated. The toolbox proxies login server-side, so
   this only matters for direct browser calls.

Without `RESEND_API_KEY` the code is written to the log instead of sent. That
makes local development possible; it is obviously not for production.

`init_db()` runs on startup. It is idempotent, and it migrates an older
deployment in place: adds the `email` column, drops `NOT NULL` from
`password_hash`, creates `login_codes`, and reconciles the seed list.

## Adding or removing people

Edit `SEED_USERS` in `database.py` and redeploy. Each entry is
`(username, email)`:

- `username` goes into the JWT and is what the rest of the toolbox knows people
  by, including the letter leaderboard. **Don't change an existing one.**
- `email` is the login identity and can be updated freely — on redeploy the
  address is reattached to that username.

Removing someone means deleting their row; taking them out of `SEED_USERS`
alone does not (nothing here deletes users, on purpose).

## Retiring passwords

`/login` and the `password_hash` column exist only so nobody is locked out
mid-transition. Existing hashes were left untouched; **new users never get
one** and can only sign in by email.

Once everyone has signed in by email:

1. Delete the `/login` route and `get_user_by_username`.
2. `ALTER TABLE users DROP COLUMN password_hash;`
3. Drop the `AUTH_USERS`-based login on the school-scraper service, if still
   present.

### A note on the old passwords

Until this change, the seed list held plaintext passwords in this repository —
`admin`, and `user1` through `user6`. They are in git history and cannot be
removed from it. Treat them as permanently compromised: they must not be reused
on any other system.

## Token lifetime

`JWT_EXPIRATION_HOURS` defaults to **168** (7 days), matching the frontend's
seven-day inactivity window. These used to disagree — tokens expired after 24
hours while the UI still believed it was signed in, so data calls started
failing behind a screen that looked fine. Keep them in step.
