"""
Database layer for Auth Service.

Login is passwordless: a short-lived numeric code is emailed to a known
address and exchanged for a JWT. There is no password to store, leak, rotate,
or read over the phone.

Nothing reads or writes `password_hash` any more; the password route is gone.
The column itself is left in place deliberately — while it holds the old
hashes, reverting the commit that removed the route restores a working
fallback. Once everyone has signed in by email, drop it (see the README).

All timestamps are decided by Postgres (`NOW()`), not by the app, so expiry
never depends on the service and the database agreeing about the clock.
"""

import os
import secrets

import bcrypt
import psycopg2
from psycopg2.extras import RealDictCursor

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable must be set")

# Railway Postgres may use postgres:// - some libs need postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

CODE_TTL_MINUTES = 10
MAX_VERIFY_ATTEMPTS = 5

# Who can log in. Email is the identity; username is what goes in the JWT and
# what the rest of the toolbox already knows people by, so it must not change.
SEED_USERS = [
    ("Koen", "koenullrich@gmail.com"),
    ("Brad", "brad@lyndeconsulting.com"),
    ("Stuart", "stuart@nonprofitsecurityadvisors.com"),
    ("Josh", "josh@nonprofitsecurityadvisors.com"),
    ("Chad", "chad@nonprofitsecurityadvisors.com"),
    ("Steven", "steven@nonprofitsecurityadvisors.com"),
    ("Jeff", "jeff@nonprofitsecurityadvisors.com"),
    ("Michael", "michael@nonprofitsecurityadvisors.com"),
]


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def init_db():
    """Create tables if absent, then reconcile the seed list. Idempotent."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password_hash BYTEA,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Pre-existing deployments have this table without an email column,
            # and with password_hash NOT NULL. Both have to give.
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)")
            cur.execute("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL")
            cur.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (LOWER(email))"
            )

            cur.execute("""
                CREATE TABLE IF NOT EXISTS login_codes (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    code_hash BYTEA NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    consumed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute(
                "CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email, created_at DESC)"
            )
            conn.commit()

            # Attach an address to whoever is already here, and add anyone new.
            # Nobody is ever given a password; email is the only identity.
            for username, email in SEED_USERS:
                cur.execute(
                    """
                    INSERT INTO users (username, email) VALUES (%s, %s)
                    ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email
                    """,
                    (username, normalize_email(email)),
                )
            conn.commit()


def get_user_by_email(email: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, username, email FROM users WHERE LOWER(email) = %s",
                (normalize_email(email),),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def codes_sent_recently(email: str, within_seconds: int) -> int:
    """How many codes this address has been sent lately — the per-user throttle."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM login_codes
                WHERE email = %s AND created_at > NOW() - (%s * INTERVAL '1 second')
                """,
                (normalize_email(email), within_seconds),
            )
            return cur.fetchone()[0]


def create_login_code(email: str) -> str:
    """Mint a code, store only its hash, and return the plaintext to be emailed.

    Any earlier code for this address is retired first, so a second request
    invalidates the first rather than leaving two valid codes in flight.
    """
    email = normalize_email(email)
    # secrets, not random — this is a credential.
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash = bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt())

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE login_codes SET consumed_at = NOW() WHERE email = %s AND consumed_at IS NULL",
                (email,),
            )
            cur.execute(
                """
                INSERT INTO login_codes (email, code_hash, expires_at)
                VALUES (%s, %s, NOW() + (%s * INTERVAL '1 minute'))
                """,
                (email, code_hash, CODE_TTL_MINUTES),
            )
            conn.commit()
    return code


def verify_login_code(email: str, code: str) -> bool:
    """Check a code and consume it. One code, one use, a bounded number of guesses.

    Returns False for every failure mode — wrong, expired, already used, or too
    many attempts — because the caller must not tell them apart either.
    """
    email = normalize_email(email)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, code_hash, attempts FROM login_codes
                WHERE email = %s AND consumed_at IS NULL AND expires_at > NOW()
                ORDER BY created_at DESC LIMIT 1
                FOR UPDATE
                """,
                (email,),
            )
            row = cur.fetchone()
            if not row:
                return False

            # Count the guess before checking it, so a crash mid-verify costs an
            # attempt rather than granting a free one.
            cur.execute(
                "UPDATE login_codes SET attempts = attempts + 1 WHERE id = %s RETURNING attempts",
                (row["id"],),
            )
            attempts = cur.fetchone()["attempts"]
            if attempts > MAX_VERIFY_ATTEMPTS:
                cur.execute(
                    "UPDATE login_codes SET consumed_at = NOW() WHERE id = %s", (row["id"],)
                )
                conn.commit()
                return False

            stored = row["code_hash"]
            if isinstance(stored, str):
                stored = stored.encode("utf-8")
            elif not isinstance(stored, bytes):
                # PostgreSQL BYTEA comes back as memoryview; bcrypt needs bytes
                stored = bytes(stored)

            # bcrypt.checkpw is constant-time for a given hash.
            ok = bcrypt.checkpw(code.strip().encode("utf-8"), stored)
            if ok:
                cur.execute(
                    "UPDATE login_codes SET consumed_at = NOW() WHERE id = %s", (row["id"],)
                )
            conn.commit()
            return ok


def purge_expired_codes() -> int:
    """Housekeeping — spent and expired codes have no reason to be kept."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM login_codes WHERE expires_at < NOW() - INTERVAL '1 day'"
            )
            deleted = cur.rowcount
            conn.commit()
            return deleted
