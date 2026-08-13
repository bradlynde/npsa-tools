"""
Job queue for deferred pipeline runs + multi-service county dispatch.

Backend selection (automatic):
  - DATABASE_URL set → Postgres (multi-service, 3 Railway containers)
  - SQLITE_PATH set → SQLite   (single-service, existing behavior)

Multi-service school runs (Postgres):
  - All 3 services share the same Postgres database on Railway.
  - Each service claims counties via SELECT ... FOR UPDATE SKIP LOCKED.
  - County results (CSV rows) stored in Postgres so any service can aggregate.
  - No shared volume required between services.
"""

from __future__ import annotations

import json
import os
import socket
import time
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from external_services import db

SCRAPER_TYPE = "school"
REPLICA_ID = os.getenv("RAILWAY_REPLICA_ID") or os.getenv("HOSTNAME") or f"replica-{os.getpid()}"
QUEUE_WORKER_LOCK_ID = 839202  # Different from church (839201) to avoid conflicts on shared DB

_lock = threading.Lock()


def is_enabled() -> bool:
    return db.is_enabled()


def _conn():
    return db.get_connection()


def _p() -> str:
    """Shortcut for the active placeholder (? or %s)."""
    return db.placeholder()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SQLITE_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS queue_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scraper_type TEXT NOT NULL,
        state TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        run_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_queue_pending
    ON queue_jobs (scraper_type, id)
    WHERE status = 'queued'
    """,
    """
    CREATE TABLE IF NOT EXISTS county_dispatch (
        run_id TEXT PRIMARY KEY,
        scraper_type TEXT NOT NULL DEFAULT 'school',
        state TEXT NOT NULL,
        total_counties INTEGER NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        meta_json TEXT,
        aggregation_owner TEXT,
        aggregation_started_at TEXT,
        aggregation_done INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_dispatch_active
    ON county_dispatch (scraper_type, cancelled, aggregation_done)
    """,
    """
    CREATE TABLE IF NOT EXISTS county_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        scraper_type TEXT NOT NULL DEFAULT 'school',
        state TEXT NOT NULL,
        county TEXT NOT NULL,
        county_index INTEGER NOT NULL,
        total_counties INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        result_json TEXT,
        error TEXT,
        UNIQUE (run_id, county)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_tasks_claim
    ON county_tasks (scraper_type, status, run_id, county_index)
    """,
    """
    CREATE TABLE IF NOT EXISTS county_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        county TEXT NOT NULL,
        csv_rows TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_results_run
    ON county_results (run_id)
    """,
]

_PG_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS queue_jobs (
        id SERIAL PRIMARY KEY,
        scraper_type TEXT NOT NULL,
        state TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        run_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_queue_pending
    ON queue_jobs (scraper_type, id)
    WHERE status = 'queued'
    """,
    """
    CREATE TABLE IF NOT EXISTS county_dispatch (
        run_id TEXT PRIMARY KEY,
        scraper_type TEXT NOT NULL DEFAULT 'school',
        state TEXT NOT NULL,
        total_counties INTEGER NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        meta_json TEXT,
        aggregation_owner TEXT,
        aggregation_started_at TEXT,
        aggregation_done INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_dispatch_active
    ON county_dispatch (scraper_type, cancelled, aggregation_done)
    """,
    """
    CREATE TABLE IF NOT EXISTS county_tasks (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        scraper_type TEXT NOT NULL DEFAULT 'school',
        state TEXT NOT NULL,
        county TEXT NOT NULL,
        county_index INTEGER NOT NULL,
        total_counties INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        result_json TEXT,
        error TEXT,
        UNIQUE (run_id, county)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_tasks_claim
    ON county_tasks (scraper_type, status, run_id, county_index)
    """,
    """
    CREATE TABLE IF NOT EXISTS county_results (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        county TEXT NOT NULL,
        csv_rows TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_county_results_run
    ON county_results (run_id)
    """,
]


# Postgres-only tables for pipeline run state (richer schema than church's pipeline_state)
_PG_EXTRA_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS pipeline_runs (
        run_id TEXT PRIMARY KEY,
        scraper_type TEXT NOT NULL DEFAULT 'school',
        state TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        display_name TEXT,
        progress INTEGER DEFAULT 0,
        current_step INTEGER DEFAULT 1,
        total_steps INTEGER DEFAULT 7,
        status_message TEXT,
        total_contacts INTEGER DEFAULT 0,
        total_contacts_with_emails INTEGER DEFAULT 0,
        total_contacts_without_emails INTEGER DEFAULT 0,
        schools_found INTEGER DEFAULT 0,
        schools_processed INTEGER DEFAULT 0,
        csv_filename TEXT,
        final_csv_path TEXT,
        error TEXT,
        counties_processed INTEGER DEFAULT 0,
        total_counties INTEGER DEFAULT 0,
        current_county TEXT,
        current_county_index INTEGER DEFAULT 0,
        county_times JSONB DEFAULT '[]'::jsonb,
        county_contacts JSONB DEFAULT '[]'::jsonb,
        county_schools JSONB DEFAULT '[]'::jsonb,
        start_time DOUBLE PRECISION,
        initial_estimated_time_remaining INTEGER,
        finalizing_at DOUBLE PRECISION,
        completed_at DOUBLE PRECISION,
        queue_job_id INTEGER,
        notify_sent BOOLEAN DEFAULT FALSE,
        archived BOOLEAN DEFAULT FALSE,
        deleted BOOLEAN DEFAULT FALSE,
        deleted_at TEXT,
        cancelled_at TEXT,
        created_at TEXT,
        updated_at TEXT,
        owner_replica TEXT,
        heartbeat_at DOUBLE PRECISION,
        extra JSONB DEFAULT '{}'::jsonb
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_pr_status ON pipeline_runs (status)",
    "CREATE INDEX IF NOT EXISTS idx_pr_state ON pipeline_runs (state, status)",
    "CREATE INDEX IF NOT EXISTS idx_pr_scraper ON pipeline_runs (scraper_type, status)",
    """
    CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        completed_counties JSONB DEFAULT '[]'::jsonb,
        next_county_index INTEGER DEFAULT 0,
        total_counties INTEGER DEFAULT 0,
        timestamp DOUBLE PRECISION,
        updated_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS final_csvs (
        run_id TEXT PRIMARY KEY,
        csv_data TEXT NOT NULL,
        csv_filename TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )
    """,
]


def init_db(*, log_ready: bool = True) -> bool:
    if not is_enabled():
        if log_ready:
            print("[QUEUE] No database configured — queue disabled")
        return False
    with _lock:
        conn = _conn()
        try:
            schema = _PG_SCHEMA if db.is_postgres() else _SQLITE_SCHEMA
            for ddl in schema:
                conn.execute(ddl)
            # Postgres-only tables (pipeline_runs, checkpoints, final_csvs)
            if db.is_postgres():
                for ddl in _PG_EXTRA_SCHEMA:
                    conn.execute(ddl)
            conn.commit()
        finally:
            conn.close()
    backend = "Postgres" if db.is_postgres() else f"SQLite at {db.sqlite_path()}"
    if log_ready:
        print(f"[QUEUE] Queue ready ({backend})")
    return True


# ---------------------------------------------------------------------------
# Job queue (simple FIFO for state runs)
# ---------------------------------------------------------------------------

def enqueue(state: str, scraper_type: str, display_name: str) -> dict[str, Any]:
    """Insert a queued job. Returns {job_id, position}."""
    state = state.lower().strip()
    now = datetime.now().isoformat()
    p = _p()
    with _lock:
        conn = _conn()
        try:
            if db.is_postgres():
                row = conn.execute(
                    f"""
                    INSERT INTO queue_jobs (scraper_type, state, display_name, status, created_at)
                    VALUES ({p}, {p}, {p}, 'queued', {p})
                    RETURNING id
                    """,
                    (scraper_type, state, display_name, now),
                ).fetchone()
                job_id = row["id"]
            else:
                cur = conn.execute(
                    f"""
                    INSERT INTO queue_jobs (scraper_type, state, display_name, status, created_at)
                    VALUES ({p}, {p}, {p}, 'queued', {p})
                    """,
                    (scraper_type, state, display_name, now),
                )
                job_id = cur.lastrowid
            pos = conn.execute(
                f"""
                SELECT COUNT(*) AS cnt FROM queue_jobs
                WHERE scraper_type = {p} AND status = 'queued' AND id <= {p}
                """,
                (scraper_type, job_id),
            ).fetchone()["cnt"]
            conn.commit()
        finally:
            conn.close()
    return {"job_id": job_id, "position": int(pos)}


def list_jobs(scraper_type: str, limit: int = 100) -> list[dict[str, Any]]:
    p = _p()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                f"""
                SELECT id, state, display_name, status, run_id, error, created_at, started_at, finished_at
                FROM queue_jobs
                WHERE scraper_type = {p}
                ORDER BY id DESC
                LIMIT {p}
                """,
                (scraper_type, limit),
            )
            rows = [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    return rows


def cancel_queued_job(job_id: int, scraper_type: str) -> bool:
    """Cancel if still queued. Returns True if a row was updated."""
    p = _p()
    with _lock:
        conn = _conn()
        try:
            now = datetime.now().isoformat()
            cur = conn.execute(
                f"""
                UPDATE queue_jobs
                SET status = 'cancelled', finished_at = {p}
                WHERE id = {p} AND scraper_type = {p} AND status = 'queued'
                """,
                (now, job_id, scraper_type),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def peek_next_queued(scraper_type: str) -> Optional[tuple[int, str]]:
    """Return (job_id, state) for oldest queued job, or None."""
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"""
                SELECT id, state FROM queue_jobs
                WHERE scraper_type = {p} AND status = 'queued'
                ORDER BY id ASC
                LIMIT 1
                """,
                (scraper_type,),
            ).fetchone()
            return (row["id"], row["state"]) if row else None
        finally:
            conn.close()


def mark_job_running(job_id: int, run_id: str, scraper_type: str) -> bool:
    """Move job from queued to running with run_id."""
    p = _p()
    now = datetime.now().isoformat()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                f"""
                UPDATE queue_jobs
                SET status = 'running', run_id = {p}, started_at = {p}
                WHERE id = {p} AND scraper_type = {p} AND status = 'queued'
                """,
                (run_id, now, job_id, scraper_type),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def finalize_job_for_run_id(run_id: str, scraper_type: str, pipeline_status: str, error_message: Optional[str]) -> None:
    """Update queue row matching run_id when pipeline thread ends."""
    if pipeline_status in ("completed", "finalizing"):
        final_status = "done"
    elif pipeline_status == "cancelled":
        final_status = "cancelled"
    elif pipeline_status == "error":
        final_status = "failed"
    else:
        final_status = "failed"
        error_message = error_message or f"Pipeline ended with status={pipeline_status}"

    p = _p()
    now = datetime.now().isoformat()
    err = error_message if final_status == "failed" else None
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                f"""
                UPDATE queue_jobs
                SET status = {p}, finished_at = {p}, error = COALESCE({p}, error)
                WHERE run_id = {p} AND scraper_type = {p} AND status = 'running'
                """,
                (final_status, now, err, run_id, scraper_type),
            )
            conn.commit()
        finally:
            conn.close()


def reconcile_stale_running(scraper_type: str) -> None:
    """Mark running jobs with no matching in-memory run as failed (e.g. after crash)."""
    pass


# ---------------------------------------------------------------------------
# County dispatch (multi-service school pipeline)
# ---------------------------------------------------------------------------

def dispatch_exists(run_id: str) -> bool:
    if not is_enabled():
        return False
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT 1 FROM county_dispatch WHERE run_id = {p} LIMIT 1",
                (run_id,),
            ).fetchone()
            return row is not None
        finally:
            conn.close()


def has_active_school_county_pipeline() -> bool:
    if not is_enabled():
        return False
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                """
                SELECT 1 FROM county_dispatch
                WHERE scraper_type = 'school' AND cancelled = 0 AND aggregation_done = 0
                LIMIT 1
                """
            ).fetchone()
            return row is not None
        finally:
            conn.close()


def active_dispatch_run_id_for_state(state: str, scraper_type: str = "school") -> Optional[str]:
    """Run ID for this state until aggregation is done."""
    if not is_enabled():
        return None
    p = _p()
    s = state.lower().strip()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"""
                SELECT d.run_id FROM county_dispatch d
                WHERE d.scraper_type = {p}
                  AND lower(d.state) = {p}
                  AND d.cancelled = 0
                  AND d.aggregation_done = 0
                ORDER BY d.created_at DESC
                LIMIT 1
                """,
                (scraper_type, s),
            ).fetchone()
            return str(row["run_id"]) if row else None
        finally:
            conn.close()


def register_dispatch_run(
    run_id: str,
    state: str,
    total_counties: int,
    scraper_type: str,
    meta: Optional[dict[str, Any]] = None,
) -> None:
    p = _p()
    now = datetime.now().isoformat()
    meta_json = json.dumps(meta or {})
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                f"""
                INSERT INTO county_dispatch (
                    run_id, scraper_type, state, total_counties, cancelled, created_at, meta_json,
                    aggregation_owner, aggregation_started_at, aggregation_done
                )
                VALUES ({p}, {p}, {p}, {p}, 0, {p}, {p}, NULL, NULL, 0)
                """,
                (run_id, scraper_type, state.lower(), int(total_counties), now, meta_json),
            )
            conn.commit()
        finally:
            conn.close()


def update_dispatch_meta(run_id: str, patch: dict[str, Any]) -> None:
    """Merge patch into meta_json (read-modify-write)."""
    if not is_enabled():
        return
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT meta_json FROM county_dispatch WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            if not row:
                return
            cur = json.loads(row["meta_json"] or "{}")
            cur.update(patch)
            conn.execute(
                f"UPDATE county_dispatch SET meta_json = {p} WHERE run_id = {p}",
                (json.dumps(cur), run_id),
            )
            conn.commit()
        finally:
            conn.close()


def cancel_dispatch_run(run_id: str) -> bool:
    if not is_enabled():
        return False
    p = _p()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                f"UPDATE county_dispatch SET cancelled = 1 WHERE run_id = {p} AND cancelled = 0",
                (run_id,),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def is_dispatch_cancelled(run_id: str) -> bool:
    if not is_enabled():
        return False
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT cancelled FROM county_dispatch WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            return bool(row and row["cancelled"])
        finally:
            conn.close()


def seed_county_tasks(
    run_id: str,
    state: str,
    scraper_type: str,
    counties: list[tuple[int, str]],
    total_counties: int,
) -> None:
    """Insert pending tasks for (county_index, county_name). Idempotent per (run_id, county)."""
    if not counties:
        return
    p = _p()
    st = state.lower()
    with _lock:
        conn = _conn()
        try:
            if db.is_postgres():
                for idx, county in counties:
                    conn.execute(
                        f"""
                        INSERT INTO county_tasks (
                            run_id, scraper_type, state, county, county_index, total_counties, status
                        )
                        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, 'pending')
                        ON CONFLICT (run_id, county) DO NOTHING
                        """,
                        (run_id, scraper_type, st, county, int(idx), int(total_counties)),
                    )
            else:
                for idx, county in counties:
                    conn.execute(
                        f"""
                        INSERT OR IGNORE INTO county_tasks (
                            run_id, scraper_type, state, county, county_index, total_counties, status
                        )
                        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, 'pending')
                        """,
                        (run_id, scraper_type, st, county, int(idx), int(total_counties)),
                    )
            conn.commit()
        finally:
            conn.close()


def claim_next_county_task(worker_id: str, scraper_type: str) -> Optional[dict[str, Any]]:
    """Atomically claim one pending task across all active dispatches.

    Uses retry with fresh connection on failure to avoid silent worker death
    when Postgres connections go stale.
    """
    if not is_enabled():
        return None
    p = _p()
    for attempt in range(2):
        now = datetime.now().isoformat()
        with _lock:
            conn = _conn()
            try:
                if db.is_postgres():
                    row = conn.execute(
                        f"""
                        SELECT ct.id FROM county_tasks ct
                        INNER JOIN county_dispatch cd ON cd.run_id = ct.run_id
                        WHERE ct.scraper_type = {p}
                          AND ct.status = 'pending'
                          AND cd.scraper_type = {p}
                          AND cd.cancelled = 0
                          AND cd.aggregation_done = 0
                        ORDER BY cd.created_at ASC, ct.county_index ASC
                        LIMIT 1
                        FOR UPDATE OF ct SKIP LOCKED
                        """,
                        (scraper_type, scraper_type),
                    ).fetchone()
                else:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute(
                        f"""
                        SELECT ct.id FROM county_tasks ct
                        INNER JOIN county_dispatch cd ON cd.run_id = ct.run_id
                        WHERE ct.scraper_type = {p}
                          AND ct.status = 'pending'
                          AND cd.scraper_type = {p}
                          AND cd.cancelled = 0
                          AND cd.aggregation_done = 0
                        ORDER BY cd.created_at ASC, ct.county_index ASC
                        LIMIT 1
                        """,
                        (scraper_type, scraper_type),
                    ).fetchone()

                if not row:
                    conn.commit()
                    return None
                tid = int(row["id"])
                cur = conn.execute(
                    f"""
                    UPDATE county_tasks
                    SET status = 'processing', claimed_by = {p}, claimed_at = {p}
                    WHERE id = {p} AND status = 'pending'
                    """,
                    (worker_id, now, tid),
                )
                if cur.rowcount == 0:
                    conn.commit()
                    return None
                out = conn.execute(
                    f"SELECT id, run_id, state, county, county_index, total_counties FROM county_tasks WHERE id = {p}",
                    (tid,),
                ).fetchone()
                conn.commit()
                return dict(out) if out else None
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                if attempt == 0:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    continue
                raise
            finally:
                conn.close()
    return None


def mark_county_done(run_id: str, county: str, result: dict[str, Any]) -> None:
    p = _p()
    payload = json.dumps(result, default=str)
    for attempt in range(2):
        now = datetime.now().isoformat()
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    f"""
                    UPDATE county_tasks
                    SET status = 'done', completed_at = {p}, result_json = {p}, error = NULL
                    WHERE run_id = {p} AND county = {p}
                    """,
                    (now, payload, run_id, county),
                )
                conn.commit()
                return
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                if attempt == 0:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    continue
                raise
            finally:
                conn.close()


def heartbeat_county_task(run_id: str, county: str) -> None:
    """Refresh claimed_at on an in-progress task so the stale-task reaper can tell
    a slow-but-alive worker from a dead replica. Best-effort: never raises."""
    p = _p()
    now = datetime.now().isoformat()
    try:
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    f"""
                    UPDATE county_tasks
                    SET claimed_at = {p}
                    WHERE run_id = {p} AND county = {p} AND status = 'processing'
                    """,
                    (now, run_id, county),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:
        pass


def mark_county_failed(run_id: str, county: str, error: str) -> None:
    p = _p()
    for attempt in range(2):
        now = datetime.now().isoformat()
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    f"""
                    UPDATE county_tasks
                    SET status = 'failed', completed_at = {p}, error = {p}, result_json = NULL
                    WHERE run_id = {p} AND county = {p}
                    """,
                    (now, error[:4000], run_id, county),
                )
                conn.commit()
                return
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                if attempt == 0:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    continue
                raise
            finally:
                conn.close()


def reclaim_stale_county_tasks(stale_seconds: int = 900) -> int:
    """Reset stuck processing tasks to pending. Returns rows updated."""
    p = _p()
    cutoff = (datetime.now() - timedelta(seconds=stale_seconds)).isoformat()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                f"""
                UPDATE county_tasks
                SET status = 'pending', claimed_by = NULL, claimed_at = NULL
                WHERE status = 'processing'
                  AND (claimed_at IS NULL OR claimed_at < {p})
                """,
                (cutoff,),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def get_run_progress(run_id: str) -> dict[str, Any]:
    """Aggregate task stats for a run."""
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"SELECT status, COUNT(*) AS n FROM county_tasks WHERE run_id = {p} GROUP BY status",
                (run_id,),
            ).fetchall()
            counts: dict[str, int] = {r["status"]: int(r["n"]) for r in rows}
            total = sum(counts.values())
            done = counts.get("done", 0)
            failed = counts.get("failed", 0)
            pending = counts.get("pending", 0)
            processing = counts.get("processing", 0)
            terminal = done + failed
            cur = conn.execute(
                f"SELECT result_json FROM county_tasks WHERE run_id = {p} AND status = 'done'",
                (run_id,),
            )
            schools = contacts = places = oc = opt = octt = 0
            for r in cur.fetchall():
                if not r["result_json"]:
                    continue
                try:
                    data = json.loads(r["result_json"])
                except json.JSONDecodeError:
                    continue
                schools += int(data.get("schools") or 0)
                contacts += int(data.get("contacts") or 0)
                places += int(data.get("places_api_calls") or 0)
                oc += int(data.get("openai_calls") or 0)
                opt += int(data.get("openai_prompt_tokens") or 0)
                octt += int(data.get("openai_completion_tokens") or 0)
            return {
                "total_tasks": total,
                "done": done,
                "failed": failed,
                "pending": pending,
                "processing": processing,
                "terminal": terminal,
                "schools_found": schools,
                "contacts_found": contacts,
                "places_api_calls_total": places,
                "openai_calls_total": oc,
                "openai_prompt_tokens_total": opt,
                "openai_completion_tokens_total": octt,
            }
        finally:
            conn.close()


def terminal_county_names_ordered(run_id: str) -> list[str]:
    """Counties in done or failed status, ordered by county_index."""
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT county FROM county_tasks
                WHERE run_id = {p} AND status IN ('done', 'failed')
                ORDER BY county_index ASC
                """,
                (run_id,),
            ).fetchall()
            return [str(r["county"]) for r in rows]
        finally:
            conn.close()


def all_county_tasks_terminal(run_id: str) -> bool:
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS n FROM county_tasks
                WHERE run_id = {p} AND status NOT IN ('done', 'failed')
                """,
                (run_id,),
            ).fetchone()
            return int(row["n"]) == 0 if row else True
        finally:
            conn.close()


def get_dispatch_row(run_id: str) -> Optional[dict[str, Any]]:
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT * FROM county_dispatch WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def try_claim_aggregation(run_id: str, claimer_id: str, stale_seconds: int = 900) -> bool:
    """Single winner for aggregate_final_results across services."""
    p = _p()
    now = datetime.now().isoformat()
    with _lock:
        conn = _conn()
        try:
            if not db.is_postgres():
                conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"""
                SELECT aggregation_owner, aggregation_started_at, aggregation_done, cancelled
                FROM county_dispatch WHERE run_id = {p}
                """,
                (run_id,),
            ).fetchone()
            if not row or row["aggregation_done"] or row["cancelled"]:
                conn.commit()
                return False
            owner = row["aggregation_owner"]
            started = row["aggregation_started_at"]
            if owner and started:
                try:
                    t0 = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                    if t0.tzinfo:
                        t0 = t0.replace(tzinfo=None)
                    age = (datetime.now() - t0).total_seconds()
                    if age < stale_seconds:
                        conn.commit()
                        return False
                except Exception:
                    pass
            cur = conn.execute(
                f"""
                UPDATE county_dispatch
                SET aggregation_owner = {p}, aggregation_started_at = {p}
                WHERE run_id = {p} AND aggregation_done = 0 AND cancelled = 0
                """,
                (claimer_id, now, run_id),
            )
            ok = cur.rowcount > 0
            conn.commit()
            return ok
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def mark_aggregation_done(run_id: str) -> None:
    p = _p()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                f"UPDATE county_dispatch SET aggregation_done = 1 WHERE run_id = {p}",
                (run_id,),
            )
            conn.commit()
        finally:
            conn.close()


def clear_aggregation_claim(run_id: str) -> None:
    """Allow another service to retry aggregation after a failed attempt."""
    p = _p()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                f"""
                UPDATE county_dispatch
                SET aggregation_owner = NULL, aggregation_started_at = NULL
                WHERE run_id = {p}
                """,
                (run_id,),
            )
            conn.commit()
        finally:
            conn.close()


def _count_tasks(run_id: str, conn) -> int:
    p = _p()
    row = conn.execute(
        f"SELECT COUNT(*) AS n FROM county_tasks WHERE run_id = {p}",
        (run_id,),
    ).fetchone()
    return int(row["n"]) if row else 0


def list_dispatch_pending_aggregation(scraper_type: str = "school") -> list[str]:
    """Run IDs where all tasks terminal but aggregation not done and not cancelled."""
    if not is_enabled():
        return []
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT d.run_id FROM county_dispatch d
                WHERE d.scraper_type = {p}
                  AND d.cancelled = 0
                  AND d.aggregation_done = 0
                """,
                (scraper_type,),
            ).fetchall()
            out: list[str] = []
            for r in rows:
                rid = str(r["run_id"])
                if _count_tasks(rid, conn) == 0:
                    continue
                row2 = conn.execute(
                    f"""
                    SELECT COUNT(*) AS n FROM county_tasks
                    WHERE run_id = {p} AND status NOT IN ('done', 'failed')
                    """,
                    (rid,),
                ).fetchone()
                if row2 and int(row2["n"]) == 0:
                    out.append(rid)
            return out
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# County results storage (Postgres multi-service: CSV rows stored in DB)
# ---------------------------------------------------------------------------

def store_county_results(run_id: str, county: str, csv_text: str, row_count: int) -> None:
    """Store CSV rows for a completed county. Used in Postgres mode so any service can aggregate."""
    if not is_enabled():
        return
    p = _p()
    now = datetime.now().isoformat()
    with _lock:
        conn = _conn()
        try:
            if db.is_postgres():
                conn.execute(
                    f"""
                    INSERT INTO county_results (run_id, county, csv_rows, row_count, created_at)
                    VALUES ({p}, {p}, {p}, {p}, {p})
                    ON CONFLICT DO NOTHING
                    """,
                    (run_id, county, csv_text, row_count, now),
                )
            else:
                conn.execute(
                    f"""
                    INSERT OR IGNORE INTO county_results (run_id, county, csv_rows, row_count, created_at)
                    VALUES ({p}, {p}, {p}, {p}, {p})
                    """,
                    (run_id, county, csv_text, row_count, now),
                )
            conn.commit()
        finally:
            conn.close()


def get_all_county_results(run_id: str) -> list[dict[str, Any]]:
    """Retrieve all county CSV results for a run (for aggregation)."""
    if not is_enabled():
        return []
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT county, csv_rows, row_count
                FROM county_results
                WHERE run_id = {p}
                ORDER BY county ASC
                """,
                (run_id,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def get_county_result_total_rows(run_id: str) -> int:
    """Total contact rows stored across all counties for a run."""
    if not is_enabled():
        return 0
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT COALESCE(SUM(row_count), 0) AS total FROM county_results WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            return int(row["total"]) if row else 0
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Internal execute helper with retry (used by pipeline_runs functions)
# ---------------------------------------------------------------------------

def _execute(query: str, params: tuple = (), fetch: str = "none") -> Any:
    """Execute a query with automatic retry on stale connection.

    Accepts %s placeholders (Postgres-style). Auto-converts for SQLite.
    """
    # Normalize placeholder for the active backend
    if not db.is_postgres():
        q = query.replace("%s", "?")
    else:
        q = query
    for attempt in range(2):
        conn = _conn()
        try:
            cur = conn.execute(q, params)
            if fetch == "one":
                row = cur.fetchone()
                conn.commit()
                return dict(row) if row else None
            elif fetch == "all":
                rows = cur.fetchall()
                conn.commit()
                return [dict(r) for r in rows]
            else:
                rc = cur.rowcount
                conn.commit()
                return rc
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            if attempt == 0:
                try:
                    conn.close()
                except Exception:
                    pass
                continue
            raise
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Pipeline runs (school-specific — richer schema than church's pipeline_state)
# ---------------------------------------------------------------------------

def create_run(run_id: str, state: str, scraper_type: str = "school",
               display_name: str = "", queue_job_id: Optional[int] = None) -> dict:
    """Create a new pipeline run entry. Returns the row as dict."""
    now = datetime.now().isoformat()
    _execute("""
        INSERT INTO pipeline_runs (
            run_id, scraper_type, state, status, display_name,
            start_time, queue_job_id, created_at, updated_at,
            status_message
        ) VALUES (%s, %s, %s, 'running', %s, %s, %s, %s, %s, %s)
        ON CONFLICT (run_id) DO UPDATE SET
            status = 'running',
            start_time = EXCLUDED.start_time,
            updated_at = EXCLUDED.updated_at,
            status_message = EXCLUDED.status_message
    """, (run_id, scraper_type, state.lower(), display_name,
          time.time(), queue_job_id, now, now,
          f"Starting pipeline for {state}..."))
    return get_run(run_id)


def get_run(run_id: str) -> Optional[dict]:
    """Get a single run by ID. Returns None if not found or deleted."""
    return _execute(
        "SELECT * FROM pipeline_runs WHERE run_id = %s AND deleted = FALSE",
        (run_id,), fetch="one"
    )


def get_run_including_deleted(run_id: str) -> Optional[dict]:
    """Get a single run by ID, including deleted."""
    return _execute(
        "SELECT * FROM pipeline_runs WHERE run_id = %s",
        (run_id,), fetch="one"
    )


def update_run(run_id: str, **fields) -> None:
    """Update specific fields on a run. Only updates provided fields."""
    if not fields:
        return
    fields["updated_at"] = datetime.now().isoformat()
    set_clauses = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [run_id]
    _execute(
        f"UPDATE pipeline_runs SET {set_clauses} WHERE run_id = %s",
        tuple(values)
    )


def claim_run_notification(run_id: str) -> bool:
    """Flip notify_sent false -> true, returning True only for the caller that won.

    Completion runs on whichever replica finishes the work, and more than one can
    reach that point for the same run. A read-then-write check races; a
    conditional UPDATE lets the database decide, so the email goes exactly once.
    """
    row = _execute(
        "UPDATE pipeline_runs SET notify_sent = TRUE "
        "WHERE run_id = %s AND notify_sent IS NOT TRUE RETURNING run_id",
        (run_id,),
        fetch="one",
    )
    return row is not None


def update_run_json_append(run_id: str, field: str, value: Any) -> None:
    """Append a value to a JSONB array field (county_times, county_contacts, etc.)."""
    _execute(
        f"UPDATE pipeline_runs SET {field} = {field} || %s::jsonb, updated_at = %s WHERE run_id = %s",
        (json.dumps([value]), datetime.now().isoformat(), run_id)
    )


def increment_run(run_id: str, **fields) -> None:
    """Increment integer fields atomically (schools_found, schools_processed, etc.)."""
    if not fields:
        return
    set_clauses = ", ".join(f"{k} = COALESCE({k}, 0) + %s" for k in fields)
    values = list(fields.values()) + [datetime.now().isoformat(), run_id]
    _execute(
        f"UPDATE pipeline_runs SET {set_clauses}, updated_at = %s WHERE run_id = %s",
        tuple(values)
    )


def delete_run(run_id: str) -> None:
    """Soft-delete a run."""
    update_run(run_id, deleted=True, deleted_at=datetime.now().isoformat())


def hard_delete_run(run_id: str) -> None:
    """Permanently delete a run and its checkpoint."""
    _execute("DELETE FROM pipeline_runs WHERE run_id = %s", (run_id,))
    _execute("DELETE FROM checkpoints WHERE run_id = %s", (run_id,))


def list_runs(scraper_type: str = "school", include_archived: bool = False) -> list:
    """List all non-deleted runs, optionally including archived."""
    if include_archived:
        rows = _execute(
            "SELECT * FROM pipeline_runs WHERE scraper_type = %s AND deleted = FALSE ORDER BY created_at DESC",
            (scraper_type,), fetch="all"
        )
    else:
        rows = _execute(
            "SELECT * FROM pipeline_runs WHERE scraper_type = %s AND deleted = FALSE AND archived = FALSE ORDER BY created_at DESC",
            (scraper_type,), fetch="all"
        )
    return rows or []


def get_active_states(scraper_type: str = "school") -> set:
    """Return set of state slugs with status='running' and recent heartbeat."""
    rows = _execute("""
        SELECT DISTINCT state FROM pipeline_runs
        WHERE scraper_type = %s AND status = 'running' AND deleted = FALSE
    """, (scraper_type,), fetch="all")
    return {r["state"] for r in (rows or [])}


def get_running_runs(scraper_type: str = "school") -> list:
    """Get all runs with status 'running'."""
    rows = _execute("""
        SELECT * FROM pipeline_runs
        WHERE scraper_type = %s AND status = 'running' AND deleted = FALSE
    """, (scraper_type,), fetch="all")
    return rows or []


def get_finalizing_runs(scraper_type: str = "school") -> list:
    """Get all runs with status 'finalizing'."""
    rows = _execute("""
        SELECT * FROM pipeline_runs
        WHERE scraper_type = %s AND status = 'finalizing' AND deleted = FALSE
    """, (scraper_type,), fetch="all")
    return rows or []


def is_state_running(state: str, scraper_type: str = "school", exclude_run_id: str = None) -> bool:
    """Check if a state has an active running run."""
    if exclude_run_id:
        row = _execute("""
            SELECT 1 FROM pipeline_runs
            WHERE scraper_type = %s AND LOWER(state) = %s AND status = 'running'
              AND deleted = FALSE AND run_id != %s
            LIMIT 1
        """, (scraper_type, state.lower(), exclude_run_id), fetch="one")
    else:
        row = _execute("""
            SELECT 1 FROM pipeline_runs
            WHERE scraper_type = %s AND LOWER(state) = %s AND status = 'running' AND deleted = FALSE
            LIMIT 1
        """, (scraper_type, state.lower()), fetch="one")
    return row is not None


def is_state_finalizing(state: str, scraper_type: str = "school") -> bool:
    """Check if a state has a finalizing run within the grace period."""
    row = _execute("""
        SELECT 1 FROM pipeline_runs
        WHERE scraper_type = %s AND LOWER(state) = %s AND status = 'finalizing'
          AND deleted = FALSE AND finalizing_at IS NOT NULL
          AND (EXTRACT(EPOCH FROM NOW()) - finalizing_at) < 120
        LIMIT 1
    """, (scraper_type, state.lower()), fetch="one")
    return row is not None


def cleanup_stale_runs(scraper_type: str = "school", stale_seconds: float = 600) -> set:
    """Mark runs as cancelled if heartbeat is stale. Transition old finalizing to completed."""
    now = time.time()
    _execute("""
        UPDATE pipeline_runs
        SET status = 'cancelled', status_message = 'Cancelled: heartbeat stale', updated_at = %s
        WHERE scraper_type = %s AND status = 'running' AND deleted = FALSE
          AND heartbeat_at IS NOT NULL AND (%s - heartbeat_at) > %s
    """, (datetime.now().isoformat(), scraper_type, now, stale_seconds))
    _execute("""
        UPDATE pipeline_runs
        SET status = 'completed', completed_at = %s, updated_at = %s,
            status_message = 'Completed (auto-transitioned from finalizing)'
        WHERE scraper_type = %s AND status = 'finalizing' AND deleted = FALSE
          AND finalizing_at IS NOT NULL AND (%s - finalizing_at) >= 120
    """, (now, datetime.now().isoformat(), scraper_type, now))
    return get_active_states(scraper_type)


def heartbeat(run_id: str) -> None:
    """Update heartbeat timestamp to signal this replica is still processing."""
    _execute(
        "UPDATE pipeline_runs SET heartbeat_at = %s WHERE run_id = %s",
        (time.time(), run_id)
    )


# ---------------------------------------------------------------------------
# Pipeline state (church-compatible upsert for cross-scraper visibility)
# ---------------------------------------------------------------------------

def upsert_pipeline_state(run_id: str, **fields) -> None:
    """Alias for update_run — provides church-compatible interface."""
    update_run(run_id, **fields)


def get_pipeline_state(run_id: str) -> Optional[dict]:
    """Alias for get_run — provides church-compatible interface."""
    return get_run(run_id)


def list_pipeline_states(scraper_type: str = "school", limit: int = 100) -> list:
    """Alias for list_runs — provides church-compatible interface."""
    return list_runs(scraper_type, include_archived=True)[:limit]


# ---------------------------------------------------------------------------
# Final CSV storage (Postgres — durable source of truth for downloads)
# ---------------------------------------------------------------------------

def store_final_csv(run_id: str, csv_data: str, csv_filename: str, row_count: int) -> None:
    """Store aggregated final CSV in Postgres."""
    if not is_enabled():
        return
    p = _p()
    now = datetime.now().isoformat()
    with _lock:
        conn = _conn()
        try:
            if db.is_postgres():
                conn.execute(
                    f"""
                    INSERT INTO final_csvs (run_id, csv_data, csv_filename, row_count, created_at)
                    VALUES ({p}, {p}, {p}, {p}, {p})
                    ON CONFLICT (run_id) DO UPDATE SET
                        csv_data = EXCLUDED.csv_data,
                        csv_filename = EXCLUDED.csv_filename,
                        row_count = EXCLUDED.row_count,
                        created_at = EXCLUDED.created_at
                    """,
                    (run_id, csv_data, csv_filename, row_count, now),
                )
            else:
                conn.execute(
                    f"""
                    INSERT OR REPLACE INTO final_csvs (run_id, csv_data, csv_filename, row_count, created_at)
                    VALUES ({p}, {p}, {p}, {p}, {p})
                    """,
                    (run_id, csv_data, csv_filename, row_count, now),
                )
            conn.commit()
        finally:
            conn.close()


def get_final_csv(run_id: str) -> Optional[dict]:
    """Retrieve final CSV for download."""
    if not is_enabled():
        return None
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT csv_data, csv_filename, row_count FROM final_csvs WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Checkpoints (school-specific — resume interrupted runs)
# ---------------------------------------------------------------------------

def save_checkpoint(run_id: str, state: str, completed_counties: list,
                    next_county_index: int, total_counties: int) -> bool:
    """Save or update checkpoint in Postgres."""
    try:
        _execute("""
            INSERT INTO checkpoints (run_id, state, completed_counties, next_county_index, total_counties, timestamp, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (run_id) DO UPDATE SET
                completed_counties = EXCLUDED.completed_counties,
                next_county_index = EXCLUDED.next_county_index,
                total_counties = EXCLUDED.total_counties,
                timestamp = EXCLUDED.timestamp,
                updated_at = EXCLUDED.updated_at
        """, (run_id, state, json.dumps(completed_counties), next_county_index,
              total_counties, time.time(), datetime.now().isoformat()))
        return True
    except Exception as e:
        print(f"[{run_id}] Error saving checkpoint: {e}")
        return False


def load_checkpoint(run_id: str) -> Optional[dict]:
    """Load checkpoint from Postgres."""
    row = _execute(
        "SELECT * FROM checkpoints WHERE run_id = %s",
        (run_id,), fetch="one"
    )
    if not row:
        return None
    if isinstance(row.get("completed_counties"), str):
        row["completed_counties"] = json.loads(row["completed_counties"])
    return row


def delete_checkpoint(run_id: str) -> None:
    """Delete checkpoint for a run."""
    _execute("DELETE FROM checkpoints WHERE run_id = %s", (run_id,))


# ---------------------------------------------------------------------------
# Leader election via advisory lock
# ---------------------------------------------------------------------------

# Persistent connection for advisory locks (session-scoped, not pooled)
_advisory_local = threading.local()


def _advisory_conn():
    """Get persistent thread-local connection for advisory locks."""
    conn = getattr(_advisory_local, "conn", None)
    if conn is None:
        url = db.database_url()
        if not url:
            return None
        try:
            import psycopg2
            conn = psycopg2.connect(url)
            conn.autocommit = True
            _advisory_local.conn = conn
        except Exception:
            return None
    else:
        try:
            # Check if connection is still alive
            conn.cursor().execute("SELECT 1")
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            url = db.database_url()
            if not url:
                return None
            import psycopg2
            conn = psycopg2.connect(url)
            conn.autocommit = True
            _advisory_local.conn = conn
    return conn


def try_acquire_queue_leader() -> bool:
    """Try to acquire the queue worker advisory lock (non-blocking).

    Returns True if this replica is the leader.
    Advisory locks are session-scoped — held until connection closes.
    """
    if not db.is_postgres():
        return True  # SQLite mode: always leader (single process)
    conn = _advisory_conn()
    if not conn:
        return False
    try:
        cur = conn.cursor()
        cur.execute("SELECT pg_try_advisory_lock(%s)", (QUEUE_WORKER_LOCK_ID,))
        result = cur.fetchone()[0]
        cur.close()
        return bool(result)
    except Exception:
        return False


def release_queue_leader() -> None:
    """Release the advisory lock."""
    if not db.is_postgres():
        return
    conn = _advisory_conn()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute("SELECT pg_advisory_unlock(%s)", (QUEUE_WORKER_LOCK_ID,))
        cur.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Row converters (school-specific — translate DB rows to frontend format)
# ---------------------------------------------------------------------------

def row_to_pipeline_format(row: dict) -> dict:
    """Convert a Postgres row to the dict format that the frontend expects."""
    if not row:
        return {}
    return {
        "status": row.get("status", "unknown"),
        "state": row.get("state", ""),
        "progress": row.get("progress", 0),
        "currentStep": row.get("current_step", 1),
        "totalSteps": row.get("total_steps", 7),
        "statusMessage": row.get("status_message", ""),
        "steps": [],
        "totalContacts": row.get("total_contacts", 0),
        "totalContactsWithEmails": row.get("total_contacts_with_emails", 0),
        "totalContactsNoEmails": row.get("total_contacts_without_emails", 0),
        "totalContactsWithoutEmails": row.get("total_contacts_without_emails", 0),
        "schoolsFound": row.get("schools_found", 0),
        "schoolsProcessed": row.get("schools_processed", 0),
        "csvData": None,
        "csvFilename": row.get("csv_filename"),
        "csvNoEmailsData": None,
        "csvNoEmailsFilename": None,
        "error": row.get("error"),
        "countiesProcessed": row.get("counties_processed", 0),
        "totalCounties": row.get("total_counties", 0),
        "currentCounty": row.get("current_county"),
        "currentCountyIndex": row.get("current_county_index", 0),
        "countyTimes": row.get("county_times", []),
        "countyContacts": row.get("county_contacts", []),
        "countySchools": row.get("county_schools", []),
        "startTime": row.get("start_time"),
        "initialEstimatedTimeRemaining": row.get("initial_estimated_time_remaining"),
        "finalizingAt": row.get("finalizing_at"),
        "completedAt": row.get("completed_at"),
        "queue_job_id": row.get("queue_job_id"),
        "notify_sent": row.get("notify_sent", False),
    }


def row_to_list_format(row: dict) -> dict:
    """Convert a Postgres row to the format expected by the /runs endpoint."""
    if not row:
        return {}
    return {
        "run_id": row.get("run_id"),
        "scraper_type": row.get("scraper_type", "school"),
        "state": row.get("state", ""),
        "status": row.get("status", "unknown"),
        "display_name": row.get("display_name", ""),
        "created_at": row.get("created_at", ""),
        "updated_at": row.get("updated_at", ""),
        "start_time": row.get("start_time"),
        "completed_at": row.get("completed_at"),
        "archived": row.get("archived", False),
        "total_contacts": row.get("total_contacts", 0),
        "total_contacts_with_emails": row.get("total_contacts_with_emails", 0),
        "total_counties": row.get("total_counties", 0),
        "counties_processed": row.get("counties_processed", 0),
        "completed_counties": [],
        "progress": row.get("progress", 0),
        "schools_found": row.get("schools_found", 0),
        "final_csv_path": row.get("final_csv_path"),
        "csv_filename": row.get("csv_filename"),
        "county_schools": row.get("county_schools", []),
    }


# ---------------------------------------------------------------------------
# County tasks helpers (frontend + crash recovery)
# ---------------------------------------------------------------------------

def get_county_tasks_for_run(run_id: str) -> list[dict[str, Any]]:
    """Return all county_tasks rows for a run, with result_json parsed."""
    if not is_enabled():
        return []
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT id, run_id, county, status, claimed_by, claimed_at, completed_at, result_json, error
                FROM county_tasks WHERE run_id = {p} ORDER BY county_index
                """,
                (run_id,),
            ).fetchall()
            tasks = []
            for r in rows:
                d = dict(r)
                if d.get("result_json"):
                    try:
                        d["result_json"] = json.loads(d["result_json"])
                    except (json.JSONDecodeError, TypeError):
                        d["result_json"] = None
                tasks.append(d)
            return tasks
        finally:
            conn.close()


def get_completed_county_tasks(run_id: str) -> list:
    """Get all completed county tasks with their results."""
    rows = _execute("""
        SELECT county, county_index, result_json, completed_at
        FROM county_tasks
        WHERE run_id = %s AND status IN ('done', 'completed', 'failed')
        ORDER BY county_index
    """, (run_id,), fetch="all")
    return rows or []


def release_stale_claims(hostname_prefix: str) -> int:
    """Crash recovery: reset processing tasks claimed by a previous incarnation."""
    if not is_enabled():
        return 0
    p = _p()
    pattern = f"{hostname_prefix}%"
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                f"""
                UPDATE county_tasks
                SET status = 'pending', claimed_by = NULL, claimed_at = NULL
                WHERE status = 'processing' AND claimed_by LIKE {p}
                """,
                (pattern,),
            )
            conn.commit()
            released = cur.rowcount
            if released:
                print(f"[QUEUE] Crash recovery: released {released} stale task(s) claimed by {hostname_prefix}*")
            return released
        finally:
            conn.close()


def list_dispatch_runs(scraper_type: str = "school") -> list[dict[str, Any]]:
    """List all dispatch runs for a scraper type."""
    if not is_enabled():
        return []
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT run_id, scraper_type, state, total_counties,
                       cancelled, aggregation_done, meta_json, created_at
                FROM county_dispatch
                WHERE scraper_type = {p}
                ORDER BY created_at DESC
                """,
                (scraper_type,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Convenience wrappers (db_state-compatible names for api.py)
# ---------------------------------------------------------------------------

def dispatch_counties(run_id: str, state: str, counties: list, scraper_type: str = "school") -> None:
    """Convenience: register dispatch + seed all county tasks in one call."""
    register_dispatch_run(run_id, state, len(counties), scraper_type)
    seed_county_tasks(run_id, state, scraper_type,
                      [(i, c) for i, c in enumerate(counties)], len(counties))
    print(f"[DISPATCH] Published {len(counties)} counties for {state} (run {run_id[:8]})")


def claim_county_task(scraper_type: str = "school") -> Optional[dict]:
    """Convenience: claim using REPLICA_ID as worker ID."""
    return claim_next_county_task(REPLICA_ID, scraper_type)


def complete_county_task(task_id: int, result: dict, csv_data: Optional[str] = None,
                         row_count: int = 0) -> dict:
    """Convenience: store CSV + mark done atomically (matches db_state signature)."""
    now = datetime.now().isoformat()
    result_json = json.dumps(result, default=str)
    p = _p()
    for attempt in range(2):
        with _lock:
            conn = _conn()
            try:
                # Store CSV and mark done in single transaction
                cur = conn.execute(
                    f"""
                    UPDATE county_tasks SET status = 'done', completed_at = {p}, result_json = {p}
                    WHERE id = {p}
                    """,
                    (now, result_json, task_id),
                )
                # Get run_id and county for CSV storage
                row = conn.execute(
                    f"SELECT run_id, county FROM county_tasks WHERE id = {p}",
                    (task_id,),
                ).fetchone()
                if csv_data and row:
                    conn.execute(
                        f"""
                        INSERT INTO county_results (run_id, county, csv_rows, row_count, created_at)
                        VALUES ({p}, {p}, {p}, {p}, {p})
                        """,
                        (row["run_id"], row["county"], csv_data, row_count, now),
                    )
                conn.commit()
                return dict(row) if row else {}
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                if attempt == 0:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    continue
                raise
            finally:
                conn.close()
    return {}


def fail_county_task(task_id: int, error: str) -> None:
    """Convenience: mark county task failed by task ID (matches db_state signature)."""
    _execute("""
        UPDATE county_tasks SET status = 'failed', completed_at = %s, error = %s
        WHERE id = %s
    """, (datetime.now().isoformat(), error, task_id))


def cancel_dispatch(run_id: str) -> None:
    """Convenience: cancel all pending tasks + mark dispatch cancelled."""
    _execute("""
        UPDATE county_tasks SET status = 'cancelled'
        WHERE run_id = %s AND status IN ('pending', 'processing')
    """, (run_id,))
    cancel_dispatch_run(run_id)


def cleanup_dispatch(run_id: str) -> None:
    """Clean up dispatch tables for a run after aggregation."""
    _execute("DELETE FROM county_tasks WHERE run_id = %s", (run_id,))
    _execute("DELETE FROM county_results WHERE run_id = %s", (run_id,))
    _execute("DELETE FROM county_dispatch WHERE run_id = %s", (run_id,))


def is_dispatch_active(scraper_type: str = "school") -> Optional[str]:
    """Check if there's an active dispatch. Returns run_id or None."""
    row = _execute("""
        SELECT run_id FROM county_dispatch
        WHERE scraper_type = %s AND aggregation_done = 0 AND cancelled = 0
        ORDER BY created_at DESC LIMIT 1
    """, (scraper_type,), fetch="one")
    return row["run_id"] if row else None


def get_dispatch_progress(run_id: str) -> dict:
    """Alias for get_run_progress with db_state-compatible return format."""
    prog = get_run_progress(run_id)
    total = prog["total_tasks"]
    completed = prog["done"] + prog["failed"]
    return {
        "total": total,
        "pending": prog["pending"],
        "running": prog["processing"],
        "completed": prog["done"],
        "failed": prog["failed"],
        "done": completed >= total and total > 0,
    }


def get_county_results(run_id: str) -> list:
    """Alias for get_all_county_results (db_state-compatible name)."""
    return get_all_county_results(run_id)


# Aliases matching db_state naming (for api.py backward compat)
init_tables = init_db
queue_enqueue = enqueue
queue_list_jobs = list_jobs
queue_cancel_job = cancel_queued_job
queue_peek_next = peek_next_queued
queue_mark_running = mark_job_running
queue_finalize = finalize_job_for_run_id
