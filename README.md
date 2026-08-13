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

## Passwords are gone

There is no password route and no password check. The only way in is to receive
mail at an address in `SEED_USERS`.

The `password_hash` column is still on the table, holding the old hashes, and
nothing reads it. That is deliberate and temporary: while those hashes exist,
reverting the commit that removed `/login` restores a working fallback. It is
the escape hatch if an address in the seed list turns out to be wrong.

Once everyone has signed in by email at least once, close it:

```sql
ALTER TABLE users DROP COLUMN password_hash;
```

Do that only when you're sure, because it cannot be undone.

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

`JWT_EXPIRATION_HOURS` defaults to **168** (7 days), matching the frontend's
seven-day inactivity window. These used to disagree — tokens expired after 24
hours while the UI still believed it was signed in, so data calls started
failing behind a screen that looked fine. Keep them in step.
