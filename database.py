"""
Database layer for Auth Service.
Uses PostgreSQL via DATABASE_URL. Creates users table on init.
"""

import os

import bcrypt
import psycopg2
from psycopg2.extras import RealDictCursor

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable must be set")

# Railway Postgres may use postgres:// - some libs need postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def init_db():
    """Create users table if not exists. Seed initial user if empty."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password_hash BYTEA NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

            # Ensure all users exist (idempotent — safe to run on every startup)
            all_users = [
                ("Koen", "admin"),
                ("Brad", "user1"),
                ("Stuart", "user2"),
                ("Josh", "user3"),
                ("Chad", "user4"),
                ("Steven", "user5"),
                ("Jeff", "user6"),
            ]
            for username, password in all_users:
                cur.execute("SELECT 1 FROM users WHERE username = %s", (username,))
                if cur.fetchone() is None:
                    pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
                    cur.execute(
                        "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
                        (username, pw_hash),
                    )
            conn.commit()


def get_user_by_username(username: str) -> dict | None:
    """Fetch user by username. Returns dict with password_hash or None."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, username, password_hash FROM users WHERE username = %s",
                (username,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
