"""
Job queue for deferred pipeline runs + multi-service county dispatch.

Backend selection (automatic):
  - DATABASE_URL set → Postgres (multi-service, 4 Railway containers)
  - SQLITE_PATH set → SQLite   (single-service, existing behavior)

Multi-service church runs (Postgres):
  - All 4 services share the same Postgres database on Railway.
  - Each service claims counties via SELECT ... FOR UPDATE SKIP LOCKED.
  - County results (CSV rows) stored in Postgres so any service can aggregate.
  - No shared volume required between services.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from external_services import db

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
        scraper_type TEXT NOT NULL DEFAULT 'church',
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
        scraper_type TEXT NOT NULL DEFAULT 'church',
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
    """
    CREATE TABLE IF NOT EXISTS pipeline_state (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        scraper_type TEXT NOT NULL DEFAULT 'church',
        display_name TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        total_counties INTEGER NOT NULL DEFAULT 0,
        counties_processed INTEGER NOT NULL DEFAULT 0,
        churches_found INTEGER NOT NULL DEFAULT 0,
        total_contacts INTEGER NOT NULL DEFAULT 0,
        total_contacts_with_emails INTEGER NOT NULL DEFAULT 0,
        status_message TEXT,
        start_time REAL,
        initial_eta INTEGER,
        completed_at TEXT,
        csv_filename TEXT,
        cost_estimate_json TEXT,
        places_api_calls INTEGER NOT NULL DEFAULT 0,
        openai_calls INTEGER NOT NULL DEFAULT 0,
        openai_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        openai_completion_tokens INTEGER NOT NULL DEFAULT 0,
        queue_job_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        scraper_type TEXT NOT NULL DEFAULT 'church',
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
        scraper_type TEXT NOT NULL DEFAULT 'church',
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
    """
    CREATE TABLE IF NOT EXISTS pipeline_state (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        scraper_type TEXT NOT NULL DEFAULT 'church',
        display_name TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        total_counties INTEGER NOT NULL DEFAULT 0,
        counties_processed INTEGER NOT NULL DEFAULT 0,
        churches_found INTEGER NOT NULL DEFAULT 0,
        total_contacts INTEGER NOT NULL DEFAULT 0,
        total_contacts_with_emails INTEGER NOT NULL DEFAULT 0,
        status_message TEXT,
        start_time REAL,
        initial_eta INTEGER,
        completed_at TEXT,
        csv_filename TEXT,
        cost_estimate_json TEXT,
        places_api_calls INTEGER NOT NULL DEFAULT 0,
        openai_calls INTEGER NOT NULL DEFAULT 0,
        openai_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        openai_completion_tokens INTEGER NOT NULL DEFAULT 0,
        queue_job_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
            from church_run_log import log_warn
            log_warn("No database configured — queue disabled")
        return False
    with _lock:
        conn = _conn()
        try:
            schema = _PG_SCHEMA if db.is_postgres() else _SQLITE_SCHEMA
            for ddl in schema:
                conn.execute(ddl)
            conn.commit()
        finally:
            conn.close()
    backend = "Postgres" if db.is_postgres() else f"SQLite at {db.sqlite_path()}"
    if log_ready:
        from church_run_log import log_warn
        log_warn(f"Queue ready ({backend})")
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
# County dispatch (multi-service church pipeline)
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


def has_active_church_county_pipeline() -> bool:
    if not is_enabled():
        return False
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                """
                SELECT 1 FROM county_dispatch
                WHERE scraper_type = 'church' AND cancelled = 0 AND aggregation_done = 0
                LIMIT 1
                """
            ).fetchone()
            return row is not None
        finally:
            conn.close()


def active_dispatch_run_id_for_state(state: str, scraper_type: str = "church") -> Optional[str]:
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
                    # Postgres: SELECT ... FOR UPDATE SKIP LOCKED for true row-level locking
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
                    # SQLite: BEGIN IMMEDIATE for file-level locking
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
                    # First failure — close stale connection and retry with a fresh one
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


def reclaim_stale_county_tasks(stale_seconds: int = 7200) -> int:
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
            churches = contacts = places = oc = opt = octt = 0
            for r in cur.fetchall():
                if not r["result_json"]:
                    continue
                try:
                    data = json.loads(r["result_json"])
                except json.JSONDecodeError:
                    continue
                churches += int(data.get("churches") or 0)
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
                "churches_found": churches,
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


def list_dispatch_pending_aggregation(scraper_type: str = "church") -> list[str]:
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


def list_dispatch_runs(scraper_type: str = "church") -> list[dict[str, Any]]:
    """List all dispatch runs for a scraper type (for /runs endpoint cross-replica visibility)."""
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
# Pipeline state (replaces in-memory pipeline_runs dict)
# ---------------------------------------------------------------------------

def upsert_pipeline_state(run_id: str, **fields) -> None:
    """Create or update pipeline run state in Postgres."""
    if not is_enabled():
        return
    p = _p()
    now = datetime.now().isoformat()
    fields.setdefault("created_at", now)
    fields["updated_at"] = now

    with _lock:
        conn = _conn()
        try:
            existing = conn.execute(
                f"SELECT run_id FROM pipeline_state WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            if existing:
                # UPDATE — only set fields that were passed
                sets = []
                vals = []
                for k, v in fields.items():
                    if k == "run_id" or k == "created_at":
                        continue
                    sets.append(f"{k} = {p}")
                    vals.append(v)
                if sets:
                    vals.append(run_id)
                    conn.execute(
                        f"UPDATE pipeline_state SET {', '.join(sets)} WHERE run_id = {p}",
                        tuple(vals),
                    )
            else:
                # INSERT
                cols = ["run_id"] + list(fields.keys())
                placeholders = ", ".join([p] * len(cols))
                col_names = ", ".join(cols)
                vals = [run_id] + list(fields.values())
                conn.execute(
                    f"INSERT INTO pipeline_state ({col_names}) VALUES ({placeholders})",
                    tuple(vals),
                )
            conn.commit()
        finally:
            conn.close()


def get_pipeline_state(run_id: str) -> Optional[dict[str, Any]]:
    """Read single run state from Postgres."""
    if not is_enabled():
        return None
    p = _p()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                f"SELECT * FROM pipeline_state WHERE run_id = {p}",
                (run_id,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def list_pipeline_states(scraper_type: str, limit: int = 100) -> list[dict[str, Any]]:
    """List all pipeline states for /runs endpoint."""
    if not is_enabled():
        return []
    p = _p()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                f"""
                SELECT * FROM pipeline_state
                WHERE scraper_type = {p}
                ORDER BY created_at DESC
                LIMIT {p}
                """,
                (scraper_type, limit),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def delete_pipeline_state(run_id: str) -> bool:
    """Delete a pipeline_state row by run_id."""
    if not is_enabled():
        return False
    p = _p()
    with _lock:
        conn = _conn()
        try:
            conn.execute(f"DELETE FROM pipeline_state WHERE run_id = {p}", (run_id,))
            conn.commit()
            return True
        finally:
            conn.close()


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


def get_final_csv(run_id: str) -> Optional[dict[str, Any]]:
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
# County tasks helpers (frontend + crash recovery)
# ---------------------------------------------------------------------------

def get_county_tasks_for_run(run_id: str) -> list[dict[str, Any]]:
    """Return all county_tasks rows for a run, with result_json parsed. For frontend countyTasks."""
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


def release_stale_claims(hostname_prefix: str) -> int:
    """Crash recovery: reset processing tasks claimed by a previous incarnation of this worker.
    Called on worker startup — releases counties that this host claimed but never completed."""
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
                from church_run_log import log_warn
                log_warn(f"Crash recovery: released {released} stale task(s) claimed by {hostname_prefix}*")
            return released
        finally:
            conn.close()
