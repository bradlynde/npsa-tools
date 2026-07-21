"""
Backend API for School Scraper Pipeline
Deploy this to Railway to handle POST requests from Vercel frontend
Processes states county-by-county to avoid timeout issues
Last updated: 2025-12-13 - Force Railway redeploy
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import subprocess
import os
import json
from datetime import datetime
import pandas as pd
import threading
import uuid
import time
from pathlib import Path
import requests
import sys
import gc  # For explicit garbage collection
from multiprocessing import Pool
import resource  # For memory monitoring
import logging  # For logging
import platform  # For OS detection
import multiprocessing  # For subprocess isolation
import re  # For regex validation
import shutil
import socket
import random
from typing import Optional

# Try to import psutil for process tree killing (optional)
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# CRITICAL: Ensure dumb-init is PID 1 for proper process reaping
# If Railway or another platform overrides the Dockerfile ENTRYPOINT,
# this check ensures dumb-init still runs as PID 1
# PID 1 check removed - no longer needed as dumb-init is properly configured

# Add parent directory to path to import pipeline
sys.path.insert(0, str(Path(__file__).parent.parent))
from pipeline import StreamingPipeline
from assets.shared.models import Contact

# Import authentication module
from external_services.auth import require_auth, verify_password, generate_token
from external_services.notify import send_run_complete_email, send_test_notification_email
from external_services import queue_store
from external_services import db
from school_run_log import (
    log_boot, log_run_start, log_county, log_county_fail, log_progress,
    log_complete, log_cost, log_warn, log_err,
    configure_worker_log_queue, clear_worker_log_queue, start_stdout_drain_thread,
)

SCRAPER_TYPE = "school"

# Handle hyphens in filenames using importlib.util
import importlib.util
_parent_dir = Path(__file__).parent.parent
_steps_dir = _parent_dir / "steps"

def load_module_with_hyphen(filename, module_name):
    """Load a Python module from a file with hyphens in the filename"""
    spec = importlib.util.spec_from_file_location(module_name, _steps_dir / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

step11_contact_splitter = load_module_with_hyphen('step11-contact_splitter.py', 'step11_contact_splitter')
step12_hunter_io = load_module_with_hyphen('step12-enrichment.py', 'step12_enrichment')
step13_final_compiler = load_module_with_hyphen('step13-compiler.py', 'step13_compiler')

app = Flask(__name__)

# CORS configuration
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN")
if ALLOWED_ORIGIN:
    ALLOWED_ORIGIN = ALLOWED_ORIGIN.rstrip('/')
else:
    ALLOWED_ORIGIN = "*"

# Configure CORS to automatically handle OPTIONS preflight requests
CORS(app, 
     resources={r"/*": {
         "origins": ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*",
         "methods": ["GET", "POST", "DELETE", "OPTIONS", "PUT"],
         "allow_headers": ["Content-Type", "Authorization"],
         "expose_headers": ["Content-Type"],
         "supports_credentials": False,
         "max_age": 86400  # 24 hours
     }},
     automatic_options=True  # Automatically handle OPTIONS requests
)

# Boot log — emitted once per container startup
ROLE = os.getenv("ROLE", "worker").lower().strip()
IS_MANAGER = ROLE == "manager"
IS_WORKER = ROLE == "worker"
log_boot(ROLE)

# Legacy in-memory dict — kept as local cache for backward compat
# Authoritative state is now in Postgres via db_state
pipeline_runs = {}

# Track running threads and cancellation flags
# Format: {run_id: {'thread': Thread, 'cancelled': bool}}
running_threads = {}


def _unique_running_states_after_stale_cleanup() -> set:
    """Expire stale 'running' / old 'finalizing' entries in Postgres; return set of state slugs still running."""
    return queue_store.cleanup_stale_runs(SCRAPER_TYPE)


def _same_state_running(state: str) -> bool:
    return queue_store.is_state_running(state, SCRAPER_TYPE)


def _state_finalizing(state: str) -> bool:
    return queue_store.is_state_finalizing(state, SCRAPER_TYPE)


# Throttle clock for the stale county-task reaper (see _school_queue_worker_loop)
_last_county_reclaim = 0.0


def _school_queue_worker_loop():
    global _last_county_reclaim
    while True:
        time.sleep(2.5)
        try:
            if not queue_store.try_acquire_queue_leader():
                continue
            # Recover counties orphaned by a dead replica: reset 'processing' tasks whose
            # heartbeat is stale (>30 min) back to 'pending'. Leader-only, throttled to 5 min.
            # 30 min >> the 60s worker heartbeat, so slow-but-alive counties are never reclaimed.
            if time.time() - _last_county_reclaim > 300:
                _last_county_reclaim = time.time()
                try:
                    n = queue_store.reclaim_stale_county_tasks(stale_seconds=1800)
                    if n:
                        log_warn(f"[reaper] reclaimed {n} stale county task(s) -> pending")
                except Exception as e:
                    log_err(f"[reaper] {e}")
            active = _unique_running_states_after_stale_cleanup()
            if len(active) >= 1:
                continue
            nxt = queue_store.queue_peek_next(SCRAPER_TYPE)
            if not nxt:
                continue
            job_id, st = nxt
            if _same_state_running(st):
                continue
            if _state_finalizing(st):
                continue
            if len(active) >= 1:
                continue
            run_id = str(uuid.uuid4())
            if not queue_store.queue_mark_running(job_id, run_id, SCRAPER_TYPE):
                continue
            run_streaming_pipeline(st, run_id, False, job_id)
        except Exception as e:
            log_err(f"Queue: {e}")


def _effective_school_parallelism() -> float:
    """Parallel slots for ETA when Postgres county queue + multiple Railway replicas are used."""
    return max(1.0, float(WORKERS_PER_REPLICA) * float(SCHOOL_REPLICA_COUNT))


def _school_log_worker_count() -> int:
    """Workers per container for startup banner."""
    return WORKERS_PER_REPLICA if db.is_postgres() else MAX_WORKERS


def _hydrate_pipeline_run_from_dispatch(run_id: str) -> bool:
    """If this replica missed run_streaming_pipeline init, rebuild minimal pipeline_runs from dispatch."""
    if run_id in pipeline_runs:
        return True
    # Try db_state run record first
    run_row = queue_store.get_run(run_id)
    if run_row:
        pipeline_runs[run_id] = queue_store.row_to_pipeline_format(run_row)
        return True
    # Fall back to dispatch table
    row = queue_store._execute(
        "SELECT * FROM county_dispatch WHERE run_id = %s",
        (run_id,), fetch="one"
    )
    if not row:
        return False
    try:
        meta = json.loads(row.get("meta_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    st = (row.get("state") or "").lower()
    pipeline_runs[run_id] = {
        "status": "running",
        "state": st,
        "progress": 0,
        "currentStep": 1,
        "totalSteps": 7,
        "statusMessage": "Restored run (multi-replica)",
        "steps": [],
        "totalContacts": 0,
        "totalContactsNoEmails": 0,
        "schoolsFound": 0,
        "schoolsProcessed": 0,
        "csvData": None,
        "csvFilename": None,
        "csvNoEmailsData": None,
        "csvNoEmailsFilename": None,
        "error": None,
        "countiesProcessed": 0,
        "totalCounties": int(row["total_counties"] or 0),
        "currentCounty": None,
        "currentCountyIndex": 0,
        "countyTimes": [],
        "countyContacts": [],
        "countySchools": [],
        "startTime": float(meta.get("startTime") or time.time()),
        "initialEstimatedTimeRemaining": meta.get("initialEstimatedTimeRemaining"),
        "queue_job_id": meta.get("queue_job_id"),
        "places_api_calls_total": 0,
        "openai_calls_total": 0,
        "openai_prompt_tokens_total": 0,
        "openai_completion_tokens_total": 0,
    }
    return True


def _merge_county_result_into_pipeline_runs(
    run_id: str,
    county: str,
    result: dict,
    county_index: int,
    total_counties: int,
    processing_time: float,
) -> None:
    """Apply one county result to in-memory progress (starter replica only)."""
    if run_id not in pipeline_runs:
        return
    progress = queue_store.get_dispatch_progress(run_id)
    done = progress["completed"] + progress["failed"]
    with progress_lock:
        pr = pipeline_runs[run_id]
        progress_pct = int((done / max(1, total_counties)) * 100) if total_counties else 0
        pr["progress"] = progress_pct
        pr["statusMessage"] = f"Processing {done}/{total_counties} counties..."
        pr["countiesProcessed"] = done
        if done < total_counties:
            pr["currentCounty"] = f"Processing {done}/{total_counties} counties"
        else:
            pr["currentCounty"] = f"All {total_counties} counties completed"
        if result.get("success"):
            pr["schoolsFound"] = pr.get("schoolsFound", 0) + int(result.get("schools") or 0)
            pr["schoolsProcessed"] = pr.get("schoolsProcessed", 0) + int(result.get("schools") or 0)
            if "countyTimes" not in pr:
                pr["countyTimes"] = []
            pr["countyTimes"].append(processing_time)
            if "countyContacts" not in pr:
                pr["countyContacts"] = []
            if "countySchools" not in pr:
                pr["countySchools"] = []
            pr["countyContacts"].append(int(result.get("contacts") or 0))
            pr["countySchools"].append(int(result.get("schools") or 0))
            pr["places_api_calls_total"] = pr.get("places_api_calls_total", 0) + int(
                result.get("places_api_calls") or 0
            )
            pr["openai_calls_total"] = pr.get("openai_calls_total", 0) + int(result.get("openai_calls") or 0)
            pr["openai_prompt_tokens_total"] = pr.get("openai_prompt_tokens_total", 0) + int(
                result.get("openai_prompt_tokens") or 0
            )
            pr["openai_completion_tokens_total"] = pr.get("openai_completion_tokens_total", 0) + int(
                result.get("openai_completion_tokens") or 0
            )
    tc = sum(pipeline_runs[run_id].get("countyContacts") or [])
    log_progress(done, total_counties, tc)
    if done % CHECKPOINT_BATCH_SIZE == 0 or done == total_counties:
        completed_tasks = queue_store.get_completed_county_tasks(run_id)
        names = [t["county"] for t in completed_tasks]
        st = pipeline_runs[run_id]["state"]
        next_index = 0
        for i, c in enumerate(load_counties_from_state(st)):
            if c in names:
                next_index = i + 1
            else:
                break
        save_checkpoint(
            run_id,
            st,
            names,
            next_index,
            total_counties,
        )
        metadata = load_run_metadata(run_id) or {}
        metadata.update(
            {
                "status": "running",
                "completed_counties": names,
                "progress": progress_pct,
                "last_checkpoint": time.time(),
            }
        )
        if not metadata.get("display_name"):
            metadata["display_name"] = _run_display_name(pipeline_runs[run_id]["state"], "school")
        save_run_metadata(run_id, metadata)
    check_health()
    log_resource_usage()
    gc.collect()
    if done < total_counties:
        time.sleep(2.0)


def _county_processor_worker_loop(worker_tag: str) -> None:
    """Daemon thread: claim county_tasks rows and run one isolated Process per county."""
    while True:
        time.sleep(0.35 + random.random() * 0.4)
        try:
            task = queue_store.claim_county_task(SCRAPER_TYPE)
            if not task:
                continue
            run_id = task["run_id"]
            state = task["state"]
            county = task["county"]
            idx = int(task["county_index"])
            total = int(task["total_counties"])
            # Check if dispatch was cancelled
            run_row = queue_store.get_run(run_id)
            if run_row and run_row.get("status") == "cancelled":
                queue_store.fail_county_task(task["id"], "cancelled")
                continue
            if run_id in running_threads and running_threads[run_id].get("cancelled"):
                queue_store.fail_county_task(task["id"], "cancelled")
                continue
            start_time = time.time()
            run_dir = RUNS_DIR / run_id
            run_dir.mkdir(parents=True, exist_ok=True)
            result_file = str(run_dir / f"{county.replace(' ', '_')}_result.json")
            proc = multiprocessing.Process(
                target=_county_worker,
                args=(state, county, run_id, idx, total, result_file),
            )
            proc.start()
            # Heartbeat the task every 60s while the county subprocess runs, so the
            # stale-task reaper can distinguish a slow-but-alive worker from a dead
            # replica. join(timeout) returns periodically without delaying completion.
            while proc.is_alive():
                proc.join(timeout=60)
                try:
                    queue_store.heartbeat_county_task(run_id, county)
                except Exception:
                    pass
            try:
                if os.path.exists(result_file):
                    with open(result_file, "r") as f:
                        result = json.load(f)
                    try:
                        os.remove(result_file)
                    except OSError:
                        pass
                else:
                    result = {"success": False, "error": "Worker did not write results file"}
            except Exception as e:
                result = {"success": False, "error": str(e)}
            elapsed = time.time() - start_time
            if not result.get("success"):
                err = result.get("error", "Unknown error")
                log_err(f"{county} County: {err}")
                queue_store.fail_county_task(task["id"], str(err))
            else:
                csv_data = None
                row_count = 0
                csv_path = result.get("csv_path")
                if csv_path and os.path.exists(csv_path):
                    try:
                        with open(csv_path, "r") as cf:
                            csv_data = cf.read()
                        row_count = max(0, csv_data.count("\n") - 1)
                    except Exception as e:
                        log_warn(f"Could not read county CSV: {e}")
                queue_store.complete_county_task(task["id"], result, csv_data, row_count)
            # Update pipeline_runs progress via db_state
            progress = queue_store.get_dispatch_progress(run_id)
            completed_count = progress["completed"] + progress["failed"]
            total_ct = progress["total"]
            progress_pct = int((completed_count / total_ct) * 100) if total_ct > 0 else 0
            queue_store.update_run(run_id,
                progress=progress_pct,
                counties_processed=completed_count,
                status_message=f"Processing {completed_count}/{total_ct} counties (distributed queue)...",
            )
            if result.get("success", False):
                queue_store.increment_run(run_id,
                    schools_found=result.get("schools", 0),
                    schools_processed=result.get("schools", 0),
                )
            queue_store.heartbeat(run_id)
            # Aggregation is handled by the manager via _watch_county_queue_until_aggregated
            _merge_county_result_into_pipeline_runs(
                run_id, county, result, idx, total, elapsed
            )
        except Exception as e:
            log_err(f"County worker {worker_tag}: {e}")
            import traceback
            traceback.print_exc()


def _watch_county_queue_until_aggregated(
    run_id: str,
    state: str,
    counties: list,
    completed_counties: list,
) -> None:
    """
    Starter-replica loop: sync task progress into pipeline_runs, then aggregate when done.
    County execution happens in _county_processor_worker_loop threads on all replicas.
    """
    wait_loops = 0
    while True:
        time.sleep(3.0)

        # Check cancellation
        run_row = queue_store.get_run(run_id)
        if running_threads.get(run_id, {}).get("cancelled") or (run_row and run_row.get("status") == "cancelled"):
            pipeline_runs[run_id]["status"] = "cancelled"
            pipeline_runs[run_id]["statusMessage"] = "Pipeline cancelled by user"
            queue_store.cancel_dispatch(run_id)
            queue_store.update_run(run_id, status="cancelled", status_message="Pipeline cancelled by user")
            return

        progress = queue_store.get_dispatch_progress(run_id)
        total = len(counties)
        terminal = progress["completed"] + progress["failed"]
        progress_pct = int((terminal / max(1, total)) * 100)
        with progress_lock:
            pipeline_runs[run_id]["progress"] = progress_pct
            pipeline_runs[run_id]["countiesProcessed"] = terminal
            if terminal < total:
                pipeline_runs[run_id]["statusMessage"] = (
                    f"Processing {terminal}/{total} counties (distributed queue)..."
                )
            else:
                pipeline_runs[run_id]["statusMessage"] = "All counties finished; aggregating..."

        # Also update db_state so other replicas can see progress
        queue_store.update_run(run_id,
            progress=progress_pct,
            counties_processed=terminal,
            status_message=pipeline_runs[run_id]["statusMessage"],
        )
        queue_store.heartbeat(run_id)

        if not progress["done"]:
            wait_loops = 0
            continue

        # All county rows terminal (done or failed)
        if queue_store.try_claim_aggregation(run_id):
            try:
                aggregate_final_results(run_id, state, skip_wait=True)
                queue_store.mark_aggregation_done(run_id)
            except Exception as e:
                log_err(f"Aggregation after county queue: {e}")
                if run_id in pipeline_runs:
                    pipeline_runs[run_id]["status"] = "error"
                    pipeline_runs[run_id]["error"] = str(e)
                    pipeline_runs[run_id]["statusMessage"] = f"Aggregation failed: {e}"
            return

        # Another replica holds the lease or will run recovery — wait for completion
        disp_progress = queue_store.get_dispatch_progress(run_id)
        # Check if aggregation is done by looking at county_dispatch table
        disp_row = queue_store._execute(
            "SELECT aggregation_done FROM county_dispatch WHERE run_id = %s",
            (run_id,), fetch="one"
        )
        if disp_row and disp_row.get("aggregation_done"):
            return
        wait_loops += 1
        if wait_loops > 4800:  # ~4h at 3s sleep
            log_warn("County queue watcher: aggregation wait timeout")
            return


def _school_aggregation_recovery_loop() -> None:
    """Pick up aggregation if the starter replica died after all counties finished."""
    while True:
        time.sleep(45.0)
        try:
            # Find dispatches where all counties are done but aggregation not yet complete
            rows = queue_store._execute("""
                SELECT cd.run_id, cd.state FROM county_dispatch cd
                WHERE cd.scraper_type = %s AND cd.aggregation_done = 0 AND cd.cancelled = 0
                  AND cd.aggregation_owner IS NULL
            """, (SCRAPER_TYPE,), fetch="all")
            for row in (rows or []):
                rid = row["run_id"]
                progress = queue_store.get_dispatch_progress(rid)
                if not progress["done"]:
                    continue
                if not queue_store.try_claim_aggregation(rid):
                    continue
                st = (row["state"] or "").lower()
                try:
                    if not _hydrate_pipeline_run_from_dispatch(rid):
                        continue
                    aggregate_final_results(rid, st, skip_wait=True)
                    queue_store.mark_aggregation_done(rid)
                except Exception as e:
                    log_err(f"[RECOVER] aggregation {rid}: {e}")
        except Exception as e:
            log_err(f"Recovery: {e}")
            import traceback
            traceback.print_exc()


def _synthetic_pipeline_status_from_dispatch(run_id: str) -> Optional[dict]:
    """When polling hits a replica that did not start the run, rebuild status from queue_store."""
    if not validate_run_id(run_id):
        return None
    # Try db_state first for the authoritative run record
    run_row = queue_store.get_run(run_id)
    if run_row:
        return queue_store.row_to_pipeline_format(run_row)
    # Fall back to dispatch tables for runs that may not have a pipeline_runs row yet
    disp_row = queue_store._execute(
        "SELECT * FROM county_dispatch WHERE run_id = %s",
        (run_id,), fetch="one"
    )
    if not disp_row:
        return None
    progress = queue_store.get_dispatch_progress(run_id)
    total = int(disp_row.get("total_counties") or 0)
    terminal = progress["completed"] + progress["failed"]
    st = (disp_row.get("state") or "").lower()
    if bool(disp_row.get("cancelled")):
        pstatus = "cancelled"
    elif bool(disp_row.get("aggregation_done")):
        pstatus = "completed"
    else:
        pstatus = "running"
    progress_pct = (
        100
        if total and terminal >= total and pstatus != "running"
        else int((terminal / max(1, total)) * 100)
    )
    return {
        "status": pstatus,
        "state": st,
        "progress": progress_pct,
        "currentStep": 1,
        "totalSteps": 7,
        "statusMessage": (
            f"County queue {terminal}/{total} (multi-replica)"
            if pstatus == "running"
            else pstatus
        ),
        "steps": [],
        "totalContacts": 0,
        "totalContactsNoEmails": 0,
        "schoolsFound": 0,
        "schoolsProcessed": 0,
        "csvData": None,
        "csvFilename": None,
        "error": None,
        "countiesProcessed": terminal,
        "totalCounties": total,
        "currentCounty": None,
        "currentCountyIndex": 0,
        "countyTimes": [],
        "countyContacts": [],
        "countySchools": [],
        "startTime": time.time(),
        "initialEstimatedTimeRemaining": None,
    }


# Track 404 requests for non-existent run IDs to prevent spam from stale browser tabs
# Format: {run_id: (first_404_time, count)}
not_found_runs = {}

# Container restart logic removed - container stays running after completion (matches backup branch)

# Storage configuration
# Ephemeral: runs, checkpoints, metadata during processing (cleaned up at run end)
EPHEMERAL_DATA_DIR = Path(os.getenv("EPHEMERAL_DATA_DIR", "/tmp/npsa_data"))
EPHEMERAL_DATA_DIR.mkdir(parents=True, exist_ok=True)

RUNS_DIR = EPHEMERAL_DATA_DIR / "runs"
CHECKPOINTS_DIR = EPHEMERAL_DATA_DIR / "checkpoints"

RUNS_DIR.mkdir(parents=True, exist_ok=True)
CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)

# Volume: final CSVs + metadata persisted here (survives container restarts)
VOLUME_DIR = Path(os.getenv("PERSISTENT_DATA_DIR", "/data"))
VOLUME_DIR.mkdir(parents=True, exist_ok=True)
METADATA_DIR = VOLUME_DIR / "metadata"
METADATA_DIR.mkdir(parents=True, exist_ok=True)

# Automatic cleanup configuration
# Delete runs older than this many days (default: 7 days)
CLEANUP_DAYS = int(os.getenv("CLEANUP_DAYS", "7"))

def cleanup_old_runs():
    """
    Clean up old completed runs to prevent storage exhaustion.
    Deletes runs older than CLEANUP_DAYS that are completed or cancelled.
    """
    try:
        import shutil
        from datetime import timedelta

        cutoff_date = datetime.now() - timedelta(days=CLEANUP_DAYS)
        deleted_count = 0
        freed_space = 0

        # Get all metadata files
        for metadata_file in METADATA_DIR.glob("*.json"):
            try:
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)

                # Skip if already deleted or still running
                if metadata.get("deleted", False):
                    continue

                status = metadata.get("status")
                if status not in ["completed", "cancelled", "error"]:
                    continue

                # Check creation date
                created_at_str = metadata.get("created_at", "")
                if not created_at_str:
                    continue

                try:
                    created_at = datetime.fromisoformat(created_at_str.replace('Z', '+00:00'))
                    if created_at.tzinfo:
                        created_at = created_at.replace(tzinfo=None)
                except Exception:
                    try:
                        created_at = datetime.strptime(created_at_str.split('.')[0], '%Y-%m-%dT%H:%M:%S')
                    except Exception:
                        continue

                if created_at < cutoff_date:
                    run_id = metadata_file.stem
                    run_dir = RUNS_DIR / run_id
                    checkpoint_file = CHECKPOINTS_DIR / f"{run_id}.json"

                    # Delete ephemeral files
                    try:
                        if run_dir.exists():
                            total_size = sum(f.stat().st_size for f in run_dir.rglob('*') if f.is_file())
                            shutil.rmtree(run_dir)
                            freed_space += total_size

                        if checkpoint_file.exists():
                            freed_space += checkpoint_file.stat().st_size
                            checkpoint_file.unlink()

                        # Delete final CSV from volume (only thing that was persisted)
                        final_csv = metadata.get("final_csv_path")
                        if final_csv and Path(final_csv).exists():
                            try:
                                Path(final_csv).unlink()
                                freed_space += Path(final_csv).stat().st_size
                            except Exception:
                                pass
                    except Exception as e:
                        continue

                    # Mark as deleted in metadata
                    metadata["deleted"] = True
                    metadata["deleted_at"] = datetime.now().isoformat()
                    metadata["auto_deleted"] = True
                    save_run_metadata(run_id, metadata)

                    deleted_count += 1
            except Exception:
                continue
    except Exception:
        pass


def _repair_stuck_metadata() -> None:
    """Fix runs stuck in 'finalizing' or 'running' that have a final CSV on the volume."""
    repaired = 0
    for metadata_file in METADATA_DIR.glob("*.json"):
        try:
            with open(metadata_file, 'r') as f:
                metadata = json.load(f)
            status = metadata.get("status", "")
            if status not in ("finalizing", "running"):
                continue
            if metadata.get("deleted"):
                continue
            run_id = metadata_file.stem
            csv_path = metadata.get("final_csv_path")
            has_csv = csv_path and Path(csv_path).exists()
            if not has_csv:
                for f in VOLUME_DIR.glob(f"*_{run_id}_*.csv"):
                    has_csv = True
                    csv_path = str(f)
                    break
            if has_csv:
                metadata["status"] = "completed"
                if not metadata.get("completed_at"):
                    metadata["completed_at"] = datetime.now().isoformat()
                if not metadata.get("completion_time"):
                    metadata["completion_time"] = time.time()
                if csv_path:
                    metadata["final_csv_path"] = csv_path
                save_run_metadata(run_id, metadata)
                repaired += 1
                log_warn(f"Repair: fixed stuck run {run_id}: {status} -> completed")
        except Exception:
            continue
    if repaired:
        log_warn(f"Repair: fixed {repaired} stuck run(s)")


def cleanup_ephemeral_run(run_id: str):
    """
    Delete all ephemeral run data after final CSV has been saved to volume.
    Removes run dir (county CSVs, chrome_tmp, etc.) and checkpoint.
    """
    try:
        run_dir = RUNS_DIR / run_id
        checkpoint_file = CHECKPOINTS_DIR / f"{run_id}.json"
        if run_dir.exists():
            shutil.rmtree(run_dir, ignore_errors=True)
        if checkpoint_file.exists():
            try:
                checkpoint_file.unlink()
            except Exception:
                pass
    except Exception:
        pass


# Batch size for checkpointing (save checkpoint every N counties)
# Set to 1 to save after every county for better recovery
CHECKPOINT_BATCH_SIZE = int(os.getenv("CHECKPOINT_BATCH_SIZE", "1"))

# Number of parallel workers for processing counties
# Default to 4 for parallel processing
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "4"))

WORKERS_PER_REPLICA = int(os.getenv("WORKERS_PER_REPLICA", os.getenv("MAX_WORKERS", "8")))
# Set to your Railway replica count for ETA math when using the Postgres county queue.
SCHOOL_REPLICA_COUNT = max(1, int(os.getenv("SCHOOL_REPLICA_COUNT", "1")))

# Estimated seconds per "parallel slot" for ETA math
SCHOOL_AVG_SECONDS_PER_COUNTY_SLOT = int(
    os.getenv("SCHOOL_AVG_SECONDS_PER_COUNTY_SLOT", "871")
)

# Thread locks for thread-safe operations
checkpoint_lock = threading.Lock()
progress_lock = threading.Lock()

# Unique ID for this process (county workers + aggregation lease)
_SCHOOL_PROCESS_ID = f"{socket.gethostname()}-{os.getpid()}-{random.randint(1, 999_999)}"

# ANSI escape codes for bold text
BOLD = '\033[1m'
RESET = '\033[0m'

def bold(text: str) -> str:
    """Make text bold in terminal output"""
    return f"{BOLD}{text}{RESET}"


# Security: Validate run_id to prevent path traversal attacks
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
# Also allow timestamp-style IDs (e.g. 20260315211349) from /data - alphanumeric, no path chars
SAFE_RUN_ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{8,64}$')

def validate_run_id(run_id: str) -> bool:
    """
    Validate that run_id is safe (UUID or alphanumeric).
    Prevents path traversal attacks (e.g., '../../../etc/passwd').
    Accepts UUID format or timestamp-style IDs from /data.
    """
    if not run_id or not isinstance(run_id, str):
        return False
    s = run_id.strip()
    return bool(UUID_PATTERN.match(s) or SAFE_RUN_ID_PATTERN.match(s))


def list_chrome_processes():
    """
    Health check function that lists all Chrome and ChromeDriver processes.
    Does NOT kill processes - only reports what exists.
    
    Returns:
        dict with process information: {
            'chrome_count': int,
            'chromedriver_count': int,
            'total_count': int,
            'chrome_processes': list of {'pid': int, 'name': str},
            'chromedriver_processes': list of {'pid': int, 'name': str}
        }
    """
    if not HAS_PSUTIL:
        return {
            'chrome_count': 0,
            'chromedriver_count': 0,
            'total_count': 0,
            'chrome_processes': [],
            'chromedriver_processes': []
        }
    
    try:
        chrome_processes = []
        chromedriver_processes = []
        
        for proc in psutil.process_iter(['name', 'pid']):
            try:
                name = proc.info['name'].lower()
                pid = proc.info['pid']
                
                if 'chromedriver' in name:
                    chromedriver_processes.append({'pid': pid, 'name': proc.info['name']})
                elif 'chrome' in name and 'chromedriver' not in name:
                    chrome_processes.append({'pid': pid, 'name': proc.info['name']})
                elif 'chromium' in name:
                    chrome_processes.append({'pid': pid, 'name': proc.info['name']})
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        
        return {
            'chrome_count': len(chrome_processes),
            'chromedriver_count': len(chromedriver_processes),
            'total_count': len(chrome_processes) + len(chromedriver_processes),
            'chrome_processes': chrome_processes,
            'chromedriver_processes': chromedriver_processes
        }
    except Exception as e:
        # Error listing processes - silently continue
        pass
        return {
            'chrome_count': 0,
            'chromedriver_count': 0,
            'total_count': 0,
            'chrome_processes': [],
            'chromedriver_processes': []
        }


def get_chrome_process_counts():
    """Get current Chrome process counts: (zombies, orphaned_zombies, active)"""
    if not HAS_PSUTIL:
        return (0, 0, 0)
    
    zombies = 0
    orphaned_zombies = 0
    active = 0
    
    try:
        for proc in psutil.process_iter(['name', 'pid', 'ppid', 'status']):
            try:
                name = proc.info.get('name', '').lower()
                status = proc.info.get('status', '').lower()
                ppid = proc.info.get('ppid', -1)
                
                if ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                    if status == 'zombie':
                        if ppid == 1:
                            orphaned_zombies += 1
                        else:
                            zombies += 1
                    else:
                        active += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, KeyError):
                continue
    except:
        pass
    
    return (zombies, orphaned_zombies, active)


def kill_chrome_processes_bottom_up(current_pid: int = None):
    """
    Kill all Chrome/Chromium/ChromeDriver processes BOTTOM-UP (children first, then parents).
    Only targets processes in the current worker's process tree (not system-wide).
    Protects main container processes (waitress-serve, main Python process).
    
    This prevents zombie processes by ensuring children are killed before parents.
    
    Args:
        current_pid: PID of current process (defaults to os.getpid())
        
    Returns:
        int: Number of processes killed
    """
    if not HAS_PSUTIL:
        return 0
    
    if current_pid is None:
        current_pid = os.getpid()
    
    # Monitor processes before cleanup
    before_zombies, before_orphaned, before_active = get_chrome_process_counts()
    
    killed_count = 0
    try:
        current_process = psutil.Process(current_pid)
        
        # Identify main container processes to protect
        # These should never be killed, even if they match patterns
        protected_names = {'waitress-serve', 'dumb-init', 'python', 'python3', 'waitress'}
        protected_pids = set()
        
        # Get main container PID (parent or grandparent process)
        try:
            parent = current_process.parent()
            if parent:
                protected_pids.add(parent.pid)
                # Also protect parent's parent (grandparent, likely waitress or main Python)
                try:
                    grandparent = parent.parent()
                    if grandparent:
                        protected_pids.add(grandparent.pid)
                        # Also protect great-grandparent (likely dumb-init or system process)
                        try:
                            great_grandparent = grandparent.parent()
                            if great_grandparent:
                                protected_pids.add(great_grandparent.pid)
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        
        # Collect all Chrome processes in worker's process tree ONLY (not system-wide)
        chrome_processes = []
        try:
            for child in current_process.children(recursive=True):
                try:
                    # child.name() returns the process name directly (no .info attribute)
                    name = child.name().lower()
                    # Check if it's a Chrome process
                    if ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                        # Skip protected processes
                        if child.pid not in protected_pids:
                            if name not in protected_names:
                                chrome_processes.append(child)
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
                    continue
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        
        if not chrome_processes:
            return 0
        
        # Sort processes by depth (deepest children first) - BOTTOM-UP approach
        # Build depth map: calculate depth of each process from current process
        depth_map = {}
        def get_depth(proc):
            if proc.pid in depth_map:
                return depth_map[proc.pid]
            try:
                if proc.pid == current_pid:
                    depth = 0
                else:
                    parent_depth = get_depth(proc.parent()) if proc.parent() else 0
                    depth = parent_depth + 1
                depth_map[proc.pid] = depth
                return depth
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return 999  # Unknown depth, kill last
        
        # Calculate depths
        for proc in chrome_processes:
            get_depth(proc)
        
        # Sort by depth descending (deepest = children first, shallowest = parents last)
        chrome_processes.sort(key=lambda p: depth_map.get(p.pid, 999), reverse=True)
        
        # Kill processes BOTTOM-UP (deepest children first)
        for proc in chrome_processes:
            try:
                if proc.is_running():
                    # Try graceful termination first
                    proc.terminate()
                    killed_count += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        
        # Wait a moment for processes to die
        if killed_count > 0:
            time.sleep(0.5)
            
            # Force kill any remaining processes
            for proc in chrome_processes:
                try:
                    if proc.is_running():
                        proc.kill()  # Force kill if still running
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    continue

        # Monitor processes after cleanup
        after_zombies, after_orphaned, after_active = get_chrome_process_counts()

    except Exception:
        pass

    return killed_count


def check_health():
    """
    Health check function that lists Chrome/ChromeDriver processes and kills orphaned ones.
    Orphaned processes (PPID=1) are killed BOTTOM-UP (children first, then parents).
    This prevents Chrome process accumulation in containers where orphaned processes escape cleanup.
    
    Also verifies that dumb-init is running as PID 1 (required for proper process reaping).
    """
    # Health check diagnostics removed - no longer needed
    # Kill orphaned processes (PPID=1) - these are processes reparented to PID 1 in containers
    # This prevents process accumulation when workers don't properly clean up
    if HAS_PSUTIL:
        try:
            orphaned_count = 0
            orphaned_processes = []
            
            # Identify main container processes to protect (never kill these)
            protected_names = {'waitress-serve', 'dumb-init', 'python', 'python3', 'waitress'}
            protected_pids = set()
            
            # Get current process and identify protected processes
            try:
                current_pid = os.getpid()
                current_process = psutil.Process(current_pid)
                try:
                    parent = current_process.parent()
                    if parent:
                        protected_pids.add(parent.pid)
                        try:
                            grandparent = parent.parent()
                            if grandparent:
                                protected_pids.add(grandparent.pid)
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            
            # Find orphaned Chrome processes (PPID=1)
            for proc in psutil.process_iter(['name', 'pid', 'ppid']):
                try:
                    name = proc.info.get('name', '').lower()
                    ppid = proc.info.get('ppid', -1)
                    
                    # Check if it's an orphaned Chrome process (PPID=1) and not protected
                    if ppid == 1 and ('chrome' in name or 'chromium' in name or 'chromedriver' in name):
                        pid = proc.info['pid']
                        if pid not in protected_pids and name not in protected_names:
                            orphaned_processes.append(proc)
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, KeyError):
                    continue
            
            if orphaned_processes:
                # Sort orphaned processes by depth (children first) - BOTTOM-UP approach
                # Build depth map: processes with more children are deeper
                depth_map = {}
                def get_orphan_depth(proc):
                    if proc.pid in depth_map:
                        return depth_map[proc.pid]
                    try:
                        # Count children depth (deeper if has more descendants)
                        children = proc.children(recursive=True)
                        depth = len(children)
                        depth_map[proc.pid] = depth
                        return depth
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        return 0
                
                # Calculate depths
                for proc in orphaned_processes:
                    get_orphan_depth(proc)
                
                # Sort by depth descending (processes with more children = deeper, kill first)
                orphaned_processes.sort(key=lambda p: depth_map.get(p.pid, 0), reverse=True)
                
                # Kill orphaned processes BOTTOM-UP (processes with more children first)
                for proc in orphaned_processes:
                    try:
                        if proc.is_running():
                            # First, try to kill children of this orphan if any (BOTTOM-UP)
                            try:
                                for child in proc.children(recursive=True):
                                    try:
                                        # child.name() returns the process name directly (no .info attribute)
                                        child_name = child.name().lower()
                                        if ('chrome' in child_name or 'chromium' in child_name or 'chromedriver' in child_name):
                                            if child.is_running():
                                                child.terminate()
                                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
                                        continue
                                time.sleep(0.3)  # Wait for children to die
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
                            
                            # Then kill the orphan process itself
                            proc.terminate()
                            orphaned_count += 1
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue
                
                # Force kill any remaining
                if orphaned_count > 0:
                    time.sleep(0.5)
                    for proc in orphaned_processes:
                        try:
                            if proc.is_running():
                                proc.kill()
                        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                            continue
                
                if orphaned_count > 0:
                    # Orphaned processes killed silently
                    pass
        except Exception as e:
            # Error killing orphaned processes - silently continue
            pass
    
    return True


def log_resource_usage():
    """Log resource usage for monitoring"""
    try:
        rusage = resource.getrusage(resource.RUSAGE_SELF)
        memory_mb = rusage.ru_maxrss / 1024  # Convert KB to MB (on Linux)
        logging.info(f"Memory: {memory_mb:.1f}MB")
    except Exception:
        pass


def save_checkpoint(run_id: str, state: str, completed_counties: list, next_county_index: int, total_counties: int):
    """Save checkpoint to persistent storage"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        raise ValueError(f"Invalid run_id format: {run_id}")
    checkpoint_path = CHECKPOINTS_DIR / f"{run_id}.json"
    checkpoint_data = {
        "run_id": run_id,
        "state": state,
        "completed_counties": completed_counties,
        "next_county_index": next_county_index,
        "total_counties": total_counties,
        "timestamp": time.time(),
        "updated_at": datetime.now().isoformat()
    }
    try:
        with open(checkpoint_path, 'w') as f:
            json.dump(checkpoint_data, f, indent=2)
        return True
    except Exception as e:
        return False


def load_checkpoint(run_id: str) -> dict:
    """Load checkpoint from persistent storage"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return None
    checkpoint_path = CHECKPOINTS_DIR / f"{run_id}.json"
    if not checkpoint_path.exists():
        return None
    try:
        with open(checkpoint_path, 'r') as f:
            checkpoint_data = json.load(f)
        return checkpoint_data
    except Exception as e:
        return None


def save_run_metadata(run_id: str, metadata: dict):
    """Save run metadata to persistent storage"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        raise ValueError(f"Invalid run_id format: {run_id}")
    metadata_path = METADATA_DIR / f"{run_id}.json"
    try:
        # Add timestamp if not present
        if "created_at" not in metadata:
            metadata["created_at"] = datetime.now().isoformat()
        metadata["updated_at"] = datetime.now().isoformat()
        
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        return True
    except Exception as e:
        return False


def load_run_metadata(run_id: str) -> dict:
    """Load run metadata from persistent storage"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return None
    metadata_path = METADATA_DIR / f"{run_id}.json"
    if not metadata_path.exists():
        return None
    try:
        with open(metadata_path, 'r') as f:
            return json.load(f)
    except Exception as e:
        return None


def _run_display_name(state: str, scraper_type: str) -> str:
    """Human-readable label for UI, e.g. 'Alabama schools' / 'Iowa churches'."""
    suffix = "churches" if scraper_type == "church" else "schools"
    if not state:
        return f"Unknown {suffix}"
    pretty = str(state).replace("_", " ").strip()
    if not pretty:
        return f"Unknown {suffix}"
    pretty = " ".join(w.capitalize() for w in pretty.split())
    return f"{pretty} {suffix}"


def _backfill_run_list_fields(metadata: dict, default_scraper_type: str) -> None:
    """Ensure scraper_type and display_name for /runs JSON (mutates dict)."""
    if "scraper_type" not in metadata:
        metadata["scraper_type"] = default_scraper_type
    st = metadata.get("scraper_type") or default_scraper_type
    if not metadata.get("display_name"):
        metadata["display_name"] = _run_display_name(metadata.get("state") or "", st)


def list_all_runs() -> list:
    """List all runs from persistent storage, excluding deleted runs"""
    runs = []
    try:
        # Get all metadata files
        for metadata_file in METADATA_DIR.glob("*.json"):
            try:
                with open(metadata_file, 'r') as f:
                    metadata = json.load(f)
                    # Skip deleted runs (filter them out from view)
                    if metadata.get("deleted", False):
                        continue
                    
                    metadata["run_id"] = metadata_file.stem  # Add run_id from filename
                    # Ensure archived field exists (default to False for backwards compatibility)
                    if "archived" not in metadata:
                        metadata["archived"] = False
                    _backfill_run_list_fields(metadata, "school")
                    runs.append(metadata)
            except Exception as e:
                continue
        
        # Sort by created_at (newest first)
        runs.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return runs
    except Exception as e:
        return []


def load_counties_from_state(state: str) -> list:
    """Load counties for a given state from assets/data/state_counties/{state}.txt
    For Texas, checks for texas_top50.txt first (for faster processing)"""
    state_normalized = state.lower().replace(' ', '_')
    repo_root = Path(__file__).parent.parent
    
    # For Texas, prefer top50 file if it exists
    if state_normalized == 'texas':
        top50_file = repo_root / 'assets' / 'data' / 'state_counties' / 'texas_top50.txt'
        if top50_file.exists():
            state_file = top50_file
        else:
            state_file = repo_root / 'assets' / 'data' / 'state_counties' / f'{state_normalized}.txt'
    else:
        state_file = repo_root / 'assets' / 'data' / 'state_counties' / f'{state_normalized}.txt'
    
    if not state_file.exists():
        raise FileNotFoundError(f"State file not found: {state_file}")
    
    counties = []
    with open(state_file, 'r', encoding='utf-8') as f:
        for line in f:
            county = line.strip()
            if county and not county.startswith('#'):
                counties.append(county)
    
    return counties


def _county_worker(state: str, county: str, run_id: str, county_index: int, total_counties: int, result_file: str):
    """
    Worker function that runs in a subprocess to process a single county.
    When this subprocess dies, all its children (Chrome processes) die automatically.
    
    Args:
        state: State name
        county: County name
        run_id: Run ID
        county_index: Index of county
        total_counties: Total number of counties
        result_file: Path to JSON file to write results to
    """
    try:
        # Update progress for this county
        
        # Create persistent output directory for this run
        run_dir = RUNS_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        county_dir = run_dir / county.replace(' ', '_')
        county_dir.mkdir(parents=True, exist_ok=True)
        
        # Create persistent output file (single file for all contacts)
        output_csv = str(county_dir / "final_contacts.csv")
        
        # Chrome tmp dir on volume to avoid ephemeral storage exhaustion; deleted after county completes
        chrome_tmp_dir = county_dir / "chrome_tmp"
        chrome_tmp_dir.mkdir(parents=True, exist_ok=True)
        
        # Initialize pipeline for this county
        pipeline = StreamingPipeline(
            google_api_key=os.getenv("GOOGLE_PLACES_API_KEY", ""),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            global_max_api_calls=None,  # No limit for full state runs
            max_pages_per_school=2,  # Reduced from 3 to 2 for faster processing
            state=state,
            chrome_tmp_dir=str(chrome_tmp_dir)
        )
        
        # Run pipeline for this single county - collects all contacts
        pipeline.run(
            counties=[county],  # Process only this county
            batch_size=0,  # Process all schools in county
            output_csv=output_csv
        )
        
        # Pipeline.run() already handles all compilation and writes to output_csv
        # Just verify the file was created
        all_contacts = pipeline.all_contacts
        
        # Count contacts with and without emails
        contacts_with_emails = [c for c in all_contacts if c.has_email()]
        contacts_without_emails = [c for c in all_contacts if not c.has_email()]
        
        # Read results
        results = {
            'success': True,
            'schools': pipeline.stats.get('schools_processed', 0),
            'contacts': len(all_contacts),
            'contacts_with_emails': len(contacts_with_emails),
            'contacts_without_emails': len(contacts_without_emails),
            'csv_path': output_csv if os.path.exists(output_csv) else None
        }
        
        # Write results to file for main process to read
        with open(result_file, 'w') as f:
            json.dump(results, f)
        
        return results
            
    except Exception as e:
        import traceback
        error_msg = str(e)[:500]
        log_county_fail(county, error_msg)
        traceback.print_exc()
        
        results = {'success': False, 'error': error_msg}
        # Write error results to file
        try:
            with open(result_file, 'w') as f:
                json.dump(results, f)
        except:
            pass
        return results
    finally:
        # CRITICAL: Cleanup Chrome processes BOTTOM-UP (children first, then parents)
        # This prevents zombie processes by ensuring children are killed before parents.
        # Only targets worker's process tree (not system-wide) to protect main container.
        
        # Monitor processes before cleanup
        before_zombies, before_orphaned, before_active = get_chrome_process_counts()
        
        try:
            # First, try to quit the driver properly
            if 'pipeline' in locals() and pipeline and hasattr(pipeline, 'content_collector') and pipeline.content_collector:
                if pipeline.content_collector.driver:
                    driver = pipeline.content_collector.driver
                    pipeline.content_collector.driver = None
                    try:
                        driver.quit()
                    except:
                        pass
        except Exception:
            pass
        
        # Kill Chrome processes BOTTOM-UP (only worker's process tree, protects main container)
        # This replaces system-wide process_iter() and pkill which could kill parents before children
        kill_chrome_processes_bottom_up()
        
        # Delete Chrome tmp dir (on volume) - no longer needed after county completes
        try:
            chrome_tmp_dir = RUNS_DIR / run_id / county.replace(' ', '_') / "chrome_tmp"
            if chrome_tmp_dir.exists():
                shutil.rmtree(chrome_tmp_dir, ignore_errors=True)
        except Exception:
            pass
        
        # Brief delay after cleanup to provide buffer
        time.sleep(1.0)
        
        # Monitor processes after cleanup
        after_zombies, after_orphaned, after_active = get_chrome_process_counts()


def process_single_county(state: str, county: str, run_id: str, county_index: int, total_counties: int):
    """
    Process a single county in a subprocess.
    The subprocess will die naturally after completion, taking all Chrome processes with it.
    
    Returns:
        dict with results: {'schools': count, 'contacts': count, 'contacts_no_emails': count, 'success': bool, 'csv_path': str}
    """
    # Create result file for subprocess to write to
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    result_file = str(run_dir / f"{county.replace(' ', '_')}_result.json")
    
    # Update progress
    pipeline_runs[run_id]["statusMessage"] = f"Processing {county} County ({county_index + 1}/{total_counties})..."
    pipeline_runs[run_id]["currentCounty"] = county
    pipeline_runs[run_id]["currentCountyIndex"] = county_index + 1
    pipeline_runs[run_id]["currentStep"] = 1
    
    # Start subprocess to run county
    # Use multiprocessing.Process to isolate the county processing
    # When the process dies, all its children (Chrome processes) die automatically
    process = multiprocessing.Process(
        target=_county_worker,
        args=(state, county, run_id, county_index, total_counties, result_file)
    )
    process.start()
    process.join()  # Wait for subprocess to complete
    
    # Read results from file
    try:
        if os.path.exists(result_file):
            with open(result_file, 'r') as f:
                results = json.load(f)
            # Clean up result file
            try:
                os.remove(result_file)
            except:
                pass
            return results
        else:
            return {'success': False, 'error': 'Subprocess did not write results file'}
    except Exception as e:
        return {'success': False, 'error': f'Error reading results: {str(e)}'}




def process_county_worker_multiprocessing(args):
    """
    Worker function for multiprocessing.Pool.
    Processes a single county and returns results.
    Does NOT update global state - that's handled in main process.
    
    This function runs in a Pool worker process, which provides the isolation.
    We call _county_worker directly (no nested subprocess needed).
    
    Args:
        args: tuple of (idx, county, state, run_id, total_counties)
    
    Returns:
        tuple: (idx, county, result_dict, processing_time_seconds)
    """
    idx, county, state, run_id, total_counties = args
    start_time = time.time()
        
    # Create result file for worker to write to
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    result_file = str(run_dir / f"{county.replace(' ', '_')}_result.json")
    
    try:
        # Call _county_worker directly - the Pool worker IS the isolation we need
        # No need for nested multiprocessing.Process since we're already in a worker
        _county_worker(state, county, run_id, idx, total_counties, result_file)
        
        # Read results from file
        if os.path.exists(result_file):
            with open(result_file, 'r') as f:
                result = json.load(f)
            # Clean up result file
            try:
                os.remove(result_file)
            except:
                pass
        else:
            result = {'success': False, 'error': 'Worker did not write results file'}
        
        processing_time = time.time() - start_time
        
        if not result.get('success'):
            log_county_fail(county, result.get("error", "Unknown error"))
        
        return (idx, county, result, processing_time)
    except Exception as e:
        processing_time = time.time() - start_time
        log_county_fail(county, str(e))
        import traceback
        traceback.print_exc()
        return (idx, county, {'success': False, 'error': str(e)}, processing_time)


def aggregate_final_results(run_id: str, state: str, skip_wait: bool = False):
    """Aggregate all county results, run global Steps 11-13, and generate final CSV
    
    Args:
        run_id: Run ID
        state: State name
        skip_wait: If True, skip waiting for counties and proceed immediately with available data
    """
    try:
        counties = load_counties_from_state(state)
        run_dir = RUNS_DIR / run_id

        # Ensure run exists in local pipeline_runs dict (may not if another replica created it)
        if run_id not in pipeline_runs:
            run_row = queue_store.get_run(run_id)
            if run_row:
                pipeline_runs[run_id] = {
                    "status": run_row.get("status", "running"),
                    "state": run_row.get("state", state).lower(),
                    "progress": run_row.get("progress", 0),
                    "statusMessage": "Aggregating...",
                    "totalContacts": run_row.get("total_contacts", 0),
                    "totalContactsWithEmails": run_row.get("total_contacts_with_emails", 0),
                    "schoolsFound": run_row.get("schools_found", 0),
                    "schoolsProcessed": run_row.get("schools_processed", 0),
                    "countiesProcessed": run_row.get("counties_processed", 0),
                    "totalCounties": run_row.get("total_counties", len(counties)),
                    "startTime": run_row.get("start_time", time.time()),
                    "csvData": None,
                    "csvFilename": run_row.get("csv_filename"),
                    "error": None,
                }
            else:
                pipeline_runs[run_id] = {
                    "status": "running",
                    "state": state.lower(),
                    "statusMessage": "Aggregating...",
                    "startTime": time.time(),
                }

        pipeline_runs[run_id]["statusMessage"] = "Waiting for all counties to complete..."
        
        # Wait for all counties to complete (check that all CSV files exist)
        # With multiprocessing pool, counties should complete more reliably, but add timeout as safety
        # Skip wait if manually triggered (skip_wait=True)
        if not skip_wait:
            max_wait_time = 7200  # 2 hours max wait (increased for large states)
            wait_interval = 5  # Check every 5 seconds
            elapsed_time = 0
            
            while elapsed_time < max_wait_time:
                all_complete = True
                missing_counties = []
                
                for county in counties:
                    county_dir = run_dir / county.replace(' ', '_')
                    county_csv = county_dir / "final_contacts.csv"
                    if not county_csv.exists():
                        all_complete = False
                        missing_counties.append(county)
                    else:
                        # File exists, check if empty
                        file_size = county_csv.stat().st_size if county_csv.exists() else 0
                        # Skip empty files - they'll be handled during aggregation
                
                if all_complete:
                    break
                
                if elapsed_time % 30 == 0:  # Log every 30 seconds
                    pass
                
                time.sleep(wait_interval)
                elapsed_time += wait_interval
            
            if not all_complete:
                log_warn(f"Some counties did not complete within timeout")
        else:
            pass
            # Skip wait - proceed immediately with available data
        
        pipeline_runs[run_id]["statusMessage"] = "Aggregating results from all counties..."
        
        # Read and combine all county CSVs into Contact objects
        all_contacts = []
        for county in counties:
            county_dir = run_dir / county.replace(' ', '_')
            county_csv = county_dir / "final_contacts.csv"
            
            if county_csv.exists():
                try:
                    df = pd.read_csv(county_csv)
                    if len(df) > 0:
                        # Convert DataFrame rows to Contact objects
                        for _, row in df.iterrows():
                            # Safe coercion helpers
                            def sval(val):
                                return str(val).strip() if val is not None and not (isinstance(val, float) and pd.isna(val)) else ""
                            
                            email_raw = row.get('email', '') or row.get('Email', '')
                            email_val = sval(email_raw)
                            if not email_val:
                                email_val = None
                            
                            contact = Contact(
                                first_name=sval(row.get('first_name', '') or row.get('First Name', '')),
                                last_name=sval(row.get('last_name', '') or row.get('Last Name', '')),
                                title=sval(row.get('title', '') or row.get('Title', '')),
                                email=email_val,
                                phone=sval(row.get('phone', '') or row.get('Phone', '')),
                                school_name=sval(row.get('school_name', '') or row.get('School Name', '')),
                                source_url=sval(row.get('source_url', '') or row.get('Source URL', ''))
                            )
                            all_contacts.append(contact)
                except Exception as e:
                    import traceback
                    traceback.print_exc()
        
        if not all_contacts:
            # Set to finalizing for 2-minute cooldown
            pipeline_runs[run_id]["status"] = "finalizing"
            pipeline_runs[run_id]["statusMessage"] = "Pipeline completed but no contacts found. Finalizing..."
            pipeline_runs[run_id]["finalizingAt"] = time.time()
            try:
                queue_store.update_run(run_id, status="finalizing", total_contacts=0, status_message="No contacts found")
            except Exception:
                pass
            
            # Create restart marker for start.sh to detect restart
            try:
                with open("/tmp/run_completed_marker", "w") as f:
                    f.write(str(time.time()))
            except:
                pass  # Ignore if can't write marker
            
            # Start background thread to transition to completed after 2 minutes
            def finalize_completion():
                time.sleep(120)  # 2-minute cooldown
                if run_id in pipeline_runs and pipeline_runs[run_id].get("status") == "finalizing":
                    pipeline_runs[run_id]["status"] = "completed"
                    pipeline_runs[run_id]["statusMessage"] = "Pipeline completed but no contacts found."
                    pipeline_runs[run_id]["completedAt"] = time.time()
                    # Final data saved - clean up ephemeral run data
                    cleanup_ephemeral_run(run_id)
                    if not pipeline_runs[run_id].get("notify_sent"):
                        duration = time.time() - pipeline_runs[run_id].get("startTime", time.time())
                        send_run_complete_email(
                            run_id, state, len(counties), len(counties), 0, 0, duration
                        )
                        pipeline_runs[run_id]["notify_sent"] = True
            
            finalize_thread = threading.Thread(target=finalize_completion, daemon=True)
            finalize_thread.start()
            pipeline_runs[run_id]["totalContacts"] = 0
            pipeline_runs[run_id]["completedAt"] = time.time()
            return
        
        
        # STEP 11: Split contacts into with/without emails
        pipeline_runs[run_id]["statusMessage"] = "Step 11: Splitting contacts..."
        splitter = step11_contact_splitter.ContactSplitter()
        contacts_with_emails, contacts_without_emails = splitter.split_contacts(all_contacts)
        
        
        # Deduplicate BEFORE enrichment (saves Hunter credits)
        compiler = step13_final_compiler.FinalCompiler()
        deduplicated = compiler.deduplicate_contacts_only(contacts_with_emails, contacts_without_emails)
        contacts_with_emails_deduped = [c for c in deduplicated if c.has_email()]
        contacts_without_emails_deduped = [c for c in deduplicated if not c.has_email()]
        
        # STEP 12: Email Enrichment with Hunter.io (optional, on deduplicated contacts only)
        contacts_enriched = []
        hunter_io_enabled = os.getenv('HUNTER_IO_API_KEY') is not None
        
        if hunter_io_enabled and contacts_without_emails_deduped:
            pipeline_runs[run_id]["statusMessage"] = f"Step 12: Enriching {len(contacts_without_emails_deduped)} contacts with Hunter.io..."
            try:
                enricher = step12_hunter_io.HunterIOEnricher(
                    api_key=os.getenv('HUNTER_IO_API_KEY'),
                    verify_emails=False,
                    score_threshold=70
                )
                contacts_enriched = enricher.enrich_contact_objects(
                    contacts=contacts_without_emails_deduped,
                    batch_size=10,
                    delay_between_batches=1.0
                )
            except Exception as e:
                import traceback
                traceback.print_exc()
        elif not hunter_io_enabled:
            pass
        elif not contacts_without_emails_deduped:
            pass
        
        # STEP 13: Compile final CSV (already deduplicated)
        pipeline_runs[run_id]["statusMessage"] = "Step 13: Compiling final CSV..."
        final_output_csv = str(run_dir / f"{state.title()}_leads_final.csv")
        
        final_csv_path = compiler.compile_contacts_to_csv(
            contacts_with_emails=contacts_with_emails_deduped,
            contacts_enriched=contacts_enriched,
            output_csv=final_output_csv,
            state=state,
            already_deduplicated=True
        )
        
        
        # Read final CSV and copy to volume (only persistent storage)
        final_data_saved_to_volume = False
        if os.path.exists(final_csv_path):
            with open(final_csv_path, 'r') as f:
                csv_content = f.read()
            
            csv_filename = f"{state.title()}_leads_{run_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            pipeline_runs[run_id]["csvData"] = csv_content
            pipeline_runs[run_id]["csvFilename"] = csv_filename
        
            # Copy final CSV to volume (only thing persisted)
            volume_csv_path = VOLUME_DIR / csv_filename
            volume_saved = False
            try:
                shutil.copy2(final_csv_path, volume_csv_path)
                volume_saved = True
                final_data_saved_to_volume = True
            except Exception as e:
                pass
        
            # Count final contacts
            final_df = pd.read_csv(final_csv_path)
            email_col = 'email' if 'email' in final_df.columns else 'Email'
            if email_col in final_df.columns:
                contacts_with_emails_final = final_df[final_df[email_col].notna() & (final_df[email_col] != '') & (final_df[email_col].str.strip() != '')]
                contacts_without_emails_final = final_df[final_df[email_col].isna() | (final_df[email_col] == '') | (final_df[email_col].str.strip() == '')]
            else:
                contacts_with_emails_final = pd.DataFrame()
                contacts_without_emails_final = final_df
            
            pipeline_runs[run_id]["totalContacts"] = len(final_df)
            pipeline_runs[run_id]["totalContactsWithEmails"] = len(contacts_with_emails_final)
            pipeline_runs[run_id]["totalContactsWithoutEmails"] = len(contacts_without_emails_final)
            
            # Save metadata (ephemeral) - final_csv_path on volume for reference
            metadata = load_run_metadata(run_id) or {}
            metadata.update({
                "final_csv_path": str(volume_csv_path) if volume_saved else final_csv_path,
                "csv_filename": csv_filename,
                "total_contacts": len(final_df),
                "total_contacts_with_emails": len(contacts_with_emails_final),
                "total_contacts_without_emails": len(contacts_without_emails_final),
                "status": "finalizing"  # Will be updated to "completed" after 2-minute cooldown
            })
            if not metadata.get("display_name"):
                metadata["display_name"] = _run_display_name(state, "school")
            save_run_metadata(run_id, metadata)
        else:
            pipeline_runs[run_id]["totalContacts"] = len(deduplicated)
            pipeline_runs[run_id]["totalContactsWithEmails"] = len(contacts_with_emails_deduped) + len(contacts_enriched)
            pipeline_runs[run_id]["totalContactsWithoutEmails"] = len(contacts_without_emails_deduped) - len(contacts_enriched)
        
        # Update final stats - set to finalizing for 2-minute cooldown
        pipeline_runs[run_id]["status"] = "finalizing"
        pipeline_runs[run_id]["statusMessage"] = f"Pipeline completed! Processed {len(counties)} counties. Enriched {len(contacts_enriched)} contacts. Finalizing..."
        pipeline_runs[run_id]["currentStep"] = 13
        pipeline_runs[run_id]["progress"] = 100
        pipeline_runs[run_id]["countiesProcessed"] = len(counties)
        pipeline_runs[run_id]["finalizingAt"] = time.time()  # Track when finalizing started
        # Sync to db_state so other replicas and API see the update
        try:
            queue_store.update_run(
                run_id,
                status="finalizing",
                progress=100,
                total_contacts=pipeline_runs[run_id].get("totalContacts", 0),
                total_contacts_with_emails=pipeline_runs[run_id].get("totalContactsWithEmails", 0),
                csv_filename=pipeline_runs[run_id].get("csvFilename"),
                status_message=f"Finalizing: {len(counties)} counties, {len(contacts_enriched)} enriched",
            )
        except Exception as db_err:
            pass
        
        # Create restart marker for start.sh to detect restart
        try:
            with open("/tmp/run_completed_marker", "w") as f:
                f.write(str(time.time()))
        except:
            pass  # Ignore if can't write marker
        
        # Start background thread to transition to completed after 2 minutes
        def finalize_completion():
            time.sleep(120)  # 2-minute cooldown
            if run_id in pipeline_runs and pipeline_runs[run_id].get("status") == "finalizing":
                pipeline_runs[run_id]["status"] = "completed"
                pipeline_runs[run_id]["statusMessage"] = f"Pipeline completed! Processed {len(counties)} counties. Enriched {len(contacts_enriched)} contacts."
                pipeline_runs[run_id]["completedAt"] = time.time()

                # Sync completion to db_state
                try:
                    queue_store.update_run(run_id, status="completed", status_message="Completed")
                except Exception:
                    pass

                # Update metadata to mark as completed (so it appears in Finished tab)
                metadata = load_run_metadata(run_id) or {}
                metadata.update({
                    "status": "completed",
                    "completed_at": datetime.now().isoformat(),
                    "completion_time": time.time()
                })
                if not metadata.get("display_name"):
                    metadata["display_name"] = _run_display_name(state, "school")
                save_run_metadata(run_id, metadata)
                if not pipeline_runs[run_id].get("notify_sent"):
                    duration = time.time() - pipeline_runs[run_id].get("startTime", time.time())
                    send_run_complete_email(
                        run_id,
                        state,
                        len(counties),
                        len(counties),
                        pipeline_runs[run_id].get("totalContacts", 0),
                        pipeline_runs[run_id].get("totalContactsWithEmails", 0),
                        duration,
                    )
                    pipeline_runs[run_id]["notify_sent"] = True
        
        # Clean up ephemeral run data only after final CSV successfully saved to volume
        if final_data_saved_to_volume:
            cleanup_ephemeral_run(run_id)
        
        finalize_thread = threading.Thread(target=finalize_completion, daemon=True)
        finalize_thread.start()
        
    except Exception as e:
        if run_id not in pipeline_runs:
            pipeline_runs[run_id] = {"status": "error", "state": state.lower()}
        pipeline_runs[run_id]["status"] = "error"
        pipeline_runs[run_id]["error"] = str(e)
        pipeline_runs[run_id]["statusMessage"] = f"Failed to aggregate results: {str(e)}"
        # Also update db_state so the error is visible across replicas
        try:
            queue_store.update_run(run_id, status="error", status_message=f"Aggregation failed: {str(e)}")
        except Exception:
            pass
        import traceback
        traceback.print_exc()


def run_streaming_pipeline(
    state: str,
    run_id: str,
    resume_from_checkpoint: bool = False,
    queue_job_id: Optional[int] = None,
):
    """
    Initialize the pipeline and process all counties (sequentially or in parallel).
    
    Processing mode is controlled by MAX_WORKERS environment variable:
    - MAX_WORKERS=1: Sequential processing (one county at a time)
    - MAX_WORKERS=2: Parallel processing with 2 workers (50% time reduction)
    - MAX_WORKERS=3: Parallel processing with 3 workers (66% time reduction)
    - MAX_WORKERS=4: Parallel processing with 4 workers (75% time reduction)
    
    Both sequential and parallel modes use multiprocessing.Pool with maxtasksperchild=1:
    - Each worker process terminates after one county, automatically cleaning up Chrome processes
    - When worker dies, OS automatically reaps all child processes (Chrome/ChromeDriver)
    - Checkpoint coordination (locks prevent race conditions)
    - Progress tracking (locks ensure accurate updates)
    - Out-of-order county completion handling (for parallel mode)
    
    This unified approach prevents Chrome process accumulation by ensuring workers
    die after each task, eliminating zombie processes in both sequential and parallel modes.
    """
    # Initialize progress tracking FIRST, before any operations that might fail
    pipeline_runs[run_id] = {
        "status": "running",
        "state": state.lower(),  # Store state for concurrent run checking
        "progress": 0,
        "currentStep": 1,
        "totalSteps": 7,
        "statusMessage": f"Starting pipeline for {state}...",
        "steps": [],
        "totalContacts": 0,
        "totalContactsNoEmails": 0,
        "schoolsFound": 0,
        "schoolsProcessed": 0,
        "csvData": None,
        "csvFilename": None,
        "csvNoEmailsData": None,
        "csvNoEmailsFilename": None,
        "error": None,
        "countiesProcessed": 0,
        "totalCounties": 0,
        "currentCounty": None,
        "currentCountyIndex": 0,
        "countyTimes": [],  # Track processing times for each county
        "countyContacts": [],  # Track contacts per county for graphs
        "countySchools": [],  # Track schools per county for graphs
        "startTime": time.time(),  # Track overall start time
        "initialEstimatedTimeRemaining": None,  # Static estimate calculated once at start (in seconds)
        "queue_job_id": queue_job_id,  # SQLite queue_jobs.id if started from queue
    }

    # Create authoritative run record in Postgres
    display_name = _run_display_name(state, SCRAPER_TYPE)
    queue_store.create_run(run_id, state, SCRAPER_TYPE, display_name, queue_job_id)

    def process_all_counties():
        """
        Process all counties (sequentially or in parallel) with checkpointing.
        
        Processing mode depends on MAX_WORKERS:
        - Sequential (MAX_WORKERS=1): One county at a time, simple loop
        - Parallel (MAX_WORKERS>1): Multiple counties simultaneously with multiprocessing.Pool
        
        If resume_from_checkpoint is True, loads checkpoint and skips counties that have data files.
        Thread locks ensure safe concurrent access to shared state.
        """
        try:
            # Load counties for state
            counties = load_counties_from_state(state)
            total_counties = len(counties)
            
            # Check if resuming from checkpoint
            completed_counties = []
            start_index = 0
            
            if resume_from_checkpoint:
                # Load checkpoint
                checkpoint = load_checkpoint(run_id)
                if checkpoint:
                    completed_counties = checkpoint.get('completed_counties', [])
                    start_index = checkpoint.get('next_county_index', 0)
                
                # Also check data files to catch counties that completed but didn't checkpoint
                # (e.g., Prince George's that completed but hung during cleanup)
                run_dir = RUNS_DIR / run_id
                if run_dir.exists():
                    for county in counties:
                        county_dir = run_dir / county.replace(' ', '_')
                        county_csv = county_dir / "final_contacts.csv"
                        if county_csv.exists() and county not in completed_counties:
                            completed_counties.append(county)
                    
                    # Recalculate start_index based on actual completed counties
                    start_index = 0
                    for i, c in enumerate(counties):
                        if c in completed_counties:
                            start_index = i + 1
                        else:
                            break
                    
                    if completed_counties:
                        pass
            
            # Save initial metadata for new run or resume
            initial_metadata = {
                "run_id": run_id,
                "state": state,
                "status": "running",
                "total_counties": total_counties,
                "completed_counties": completed_counties,
                "start_time": time.time(),
                "created_at": datetime.now().isoformat(),
                "scraper_type": "school",
                "display_name": _run_display_name(state, "school"),
            }
            save_run_metadata(run_id, initial_metadata)
            
            if resume_from_checkpoint and completed_counties:
                pass
            else:
                pass
            
            # Update progress tracking with county info
            pipeline_runs[run_id]["totalCounties"] = total_counties
            pipeline_runs[run_id]["statusMessage"] = f"Processing {state} ({len(completed_counties)}/{total_counties} counties completed)..."
            pipeline_runs[run_id]["currentCounty"] = "Starting..." if not completed_counties else f"Resuming from {len(completed_counties)}/{total_counties}"
            pipeline_runs[run_id]["countiesProcessed"] = len(completed_counties)
            
            # Calculate static initial estimated time remaining (only if not already set)
            eff_parallel = (
                _effective_school_parallelism() if db.is_postgres() else float(MAX_WORKERS)
            )
            if pipeline_runs[run_id].get("initialEstimatedTimeRemaining") is None:
                remaining_counties_count = total_counties - len(completed_counties)
                avg_time_per_county = SCHOOL_AVG_SECONDS_PER_COUNTY_SLOT
                effective_remaining = max(1, remaining_counties_count / eff_parallel)
                initial_estimate = effective_remaining * avg_time_per_county
                pipeline_runs[run_id]["initialEstimatedTimeRemaining"] = int(initial_estimate)

            # Process remaining counties (skip completed ones if resuming)
            remaining_counties = [(idx, county) for idx, county in enumerate(counties) if county not in completed_counties]
            use_dispatch_queue = db.is_postgres()

            if use_dispatch_queue:
                # Multi-replica: county_tasks in Postgres; Process workers on each replica claim tasks.
                remaining_county_names = [c for _, c in remaining_counties]
                if remaining_county_names:
                    queue_store.dispatch_counties(run_id, state, remaining_county_names, SCRAPER_TYPE)
                queue_store.update_run(run_id,
                    total_counties=total_counties,
                    counties_processed=len(completed_counties),
                    initial_estimated_time_remaining=pipeline_runs[run_id].get("initialEstimatedTimeRemaining"),
                )
                if not remaining_counties:
                    pipeline_runs[run_id]["progress"] = 100
                    pipeline_runs[run_id]["countiesProcessed"] = total_counties
                    pipeline_runs[run_id]["statusMessage"] = (
                        f"All {total_counties} counties already completed"
                    )
                log_run_start(state, total_counties, _school_log_worker_count())
                _watch_county_queue_until_aggregated(run_id, state, counties, completed_counties)
                return  # dispatch path handles aggregation internally

            # Determine processing mode message
            remaining_count = total_counties - len(completed_counties)
            if MAX_WORKERS == 1:
                pass
            else:
                pass
            
            if not remaining_counties:
                # Update progress to show all complete
                pipeline_runs[run_id]["progress"] = 100
                pipeline_runs[run_id]["countiesProcessed"] = total_counties
                pipeline_runs[run_id]["statusMessage"] = f"All {total_counties} counties already completed"
                # Continue to aggregation - skip the pool processing
            else:
                # UNIFIED PROCESSING: Use Pool for both sequential (MAX_WORKERS=1) and parallel (MAX_WORKERS>1)
                # maxtasksperchild=1 forces each worker to terminate after one county,
                # which automatically cleans up all Chrome child processes when the worker dies
                with Pool(processes=MAX_WORKERS, maxtasksperchild=1) as pool:
                    # Submit all remaining counties to the pool
                    pool_args = [(idx, county, state, run_id, total_counties) for idx, county in remaining_counties]
                    
                    # Use imap_unordered to get results as they complete (out-of-order is handled)
                    # Track which counties we've submitted to handle failures gracefully
                    failed_counties = []
                    try:
                        for idx, county, result, processing_time in pool.imap_unordered(process_county_worker_multiprocessing, pool_args):
                            # Check for cancellation
                            if running_threads.get(run_id, {}).get('cancelled', False):
                                pool.terminate()  # Force kill all workers
                                pool.join()
                                pipeline_runs[run_id]["status"] = "cancelled"
                                pipeline_runs[run_id]["statusMessage"] = "Pipeline cancelled by user"
                                return
                            
                            # Handle worker failures gracefully - continue processing other counties
                            if not result.get('success', False):
                                error_msg = result.get('error', 'Unknown error')
                                log_county_fail(county, error_msg)
                                failed_counties.append(county)
                                # Still mark as completed to avoid infinite retry, but log the failure
                                with checkpoint_lock:
                                    if county not in completed_counties:
                                        completed_counties.append(county)
                                continue
                            
                            # Update progress in main process (thread-safe)
                            with checkpoint_lock:
                                if county not in completed_counties:
                                    completed_counties.append(county)
                            
                            completed = len(completed_counties)
                            progress_pct = int((completed / total_counties) * 100)
                            
                            # Update pipeline_runs state
                            with progress_lock:
                                pipeline_runs[run_id]["progress"] = progress_pct
                                pipeline_runs[run_id]["statusMessage"] = f"Processing {completed}/{total_counties} counties..."
                                pipeline_runs[run_id]["countiesProcessed"] = completed
                                # Set currentCounty to show progress (since we're processing in parallel, show the count)
                                # This replaces "Initializing..." with actual progress
                                if completed < total_counties:
                                    pipeline_runs[run_id]["currentCounty"] = f"Processing {completed}/{total_counties} counties"
                                else:
                                    pipeline_runs[run_id]["currentCounty"] = f"All {total_counties} counties completed"
                                pipeline_runs[run_id]["schoolsFound"] = pipeline_runs[run_id].get("schoolsFound", 0) + result.get('schools', 0)
                                pipeline_runs[run_id]["schoolsProcessed"] = pipeline_runs[run_id].get("schoolsProcessed", 0) + result.get('schools', 0)
                                
                                # Track county timing for average calculation
                                if "countyTimes" not in pipeline_runs[run_id]:
                                    pipeline_runs[run_id]["countyTimes"] = []
                                pipeline_runs[run_id]["countyTimes"].append(processing_time)
                                
                                # Track per-county contacts and schools for graphs
                                if "countyContacts" not in pipeline_runs[run_id]:
                                    pipeline_runs[run_id]["countyContacts"] = []
                                if "countySchools" not in pipeline_runs[run_id]:
                                    pipeline_runs[run_id]["countySchools"] = []
                                
                                pipeline_runs[run_id]["countyContacts"].append(result.get('contacts', 0))
                                pipeline_runs[run_id]["countySchools"].append(result.get('schools', 0))
                            
                            
                            # Save checkpoint after every county (CHECKPOINT_BATCH_SIZE=1) or at completion
                            # This is for progress tracking only - runs always start fresh, no resume logic
                            is_checkpoint = completed % CHECKPOINT_BATCH_SIZE == 0 or completed == total_counties
                            if is_checkpoint:
                                # Calculate next county index: find the highest index of completed counties + 1
                                # This handles out-of-order completion in parallel mode
                                next_index = 0
                                for i, c in enumerate(counties):
                                    if c in completed_counties:
                                        next_index = i + 1
                                    else:
                                        # Found first incomplete county
                                        break
                                
                                save_checkpoint(run_id, state, completed_counties, next_index, total_counties)
                                
                                # Update metadata
                                metadata = load_run_metadata(run_id) or {}
                                metadata.update({
                                    "status": "running",
                                    "completed_counties": completed_counties,
                                    "progress": progress_pct,
                                    "last_checkpoint": time.time()
                                })
                                if not metadata.get("display_name"):
                                    metadata["display_name"] = _run_display_name(state, "school")
                                save_run_metadata(run_id, metadata)
                                
                            
                            # Health check after each county (lists remaining processes)
                            check_health()
                            
                            # Resource monitoring
                            log_resource_usage()
                            
                            # EXPLICIT GARBAGE COLLECTION: Force cleanup after each county
                            gc.collect()
                            
                            # 2-second delay between counties to provide buffer for cleanup
                            if completed < total_counties:
                                time.sleep(2.0)
                    
                    except KeyboardInterrupt:
                        pool.terminate()
                        pool.join()
                        # Save checkpoint before exiting
                        save_checkpoint(run_id, state, completed_counties, start_index + len(completed_counties), total_counties)
                        pipeline_runs[run_id]["status"] = "cancelled"
                        pipeline_runs[run_id]["statusMessage"] = "Pipeline cancelled by user"
                        return
                    except Exception as e:
                        import traceback
                        traceback.print_exc()
                        # Save checkpoint before terminating
                        save_checkpoint(run_id, state, completed_counties, start_index + len(completed_counties), total_counties)
                        pool.terminate()
                        pool.join()
                        # Don't crash - try to continue to aggregation if we have some results
                        if len(completed_counties) > 0:
                            pass
                        else:
                            # No progress made, mark as error
                            if run_id in pipeline_runs:
                                pipeline_runs[run_id]["status"] = "error"
                                pipeline_runs[run_id]["error"] = f"Pool processing failed: {str(e)}"
                                pipeline_runs[run_id]["statusMessage"] = f"Pipeline failed: {str(e)}"
                    
                    # Log any failed counties after all processing completes
                    if failed_counties:
                        log_warn(f"{len(failed_counties)} counties failed: {', '.join(failed_counties[:5])}")
                        if run_id in pipeline_runs:
                            pipeline_runs[run_id]["statusMessage"] = f"Completed with {len(failed_counties)} failures"
                            return
            
            # All counties completed, aggregate results
            try:
                aggregate_final_results(run_id, state)
            except Exception as e:
                import traceback
                traceback.print_exc()
                # Still mark as completed if we have results
                if run_id in pipeline_runs:
                    pipeline_runs[run_id]["status"] = "error"
                    pipeline_runs[run_id]["error"] = f"Aggregation failed: {str(e)}"
            
            # Final checkpoint - mark as completed (always save, even if aggregation failed)
            save_checkpoint(run_id, state, completed_counties, len(counties), total_counties)
            final_metadata = load_run_metadata(run_id) or {}
            final_metadata.update({
                "status": "completed" if run_id in pipeline_runs and pipeline_runs[run_id].get("status") != "error" else "error",
                "completed_counties": completed_counties,
                "progress": 100,
                "completed_at": datetime.now().isoformat(),
                "completion_time": time.time(),
                "scraper_type": "school",
                "display_name": _run_display_name(state, "school"),
                "schoolsFound": pipeline_runs.get(run_id, {}).get("schoolsFound", 0),
                "schoolsProcessed": pipeline_runs.get(run_id, {}).get("schoolsProcessed", 0),
                "countySchools": pipeline_runs.get(run_id, {}).get("countySchools", []),
            })
            save_run_metadata(run_id, final_metadata)
            
            # Final status update - set to finalizing for 2-minute cooldown
            if run_id in pipeline_runs:
                if pipeline_runs[run_id].get("status") != "error":
                    pipeline_runs[run_id]["status"] = "finalizing"
                    pipeline_runs[run_id]["statusMessage"] = f"Pipeline completed: {len(completed_counties)}/{total_counties} counties processed. Finalizing..."
                    pipeline_runs[run_id]["finalizingAt"] = time.time()
                    pipeline_runs[run_id]["containerResetRequested"] = True
                    
                    # Create restart marker for start.sh to detect restart
                    try:
                        with open("/tmp/run_completed_marker", "w") as f:
                            f.write(str(time.time()))
                    except:
                        pass  # Ignore if can't write marker
                    
                    # Start background thread to transition to completed after 2 minutes
                    def finalize_completion():
                        time.sleep(120)  # 2-minute cooldown
                        if run_id in pipeline_runs and pipeline_runs[run_id].get("status") == "finalizing":
                            pipeline_runs[run_id]["status"] = "completed"
                            pipeline_runs[run_id]["statusMessage"] = f"Pipeline completed: {len(completed_counties)}/{total_counties} counties processed"
                            pipeline_runs[run_id]["completedAt"] = time.time()
                            if not pipeline_runs[run_id].get("notify_sent"):
                                duration = time.time() - pipeline_runs[run_id].get("startTime", time.time())
                                send_run_complete_email(
                                    run_id,
                                    state,
                                    len(completed_counties),
                                    total_counties,
                                    pipeline_runs[run_id].get("totalContacts", 0),
                                    pipeline_runs[run_id].get("totalContactsWithEmails", 0),
                                    duration,
                                )
                                pipeline_runs[run_id]["notify_sent"] = True
                    
                    finalize_thread = threading.Thread(target=finalize_completion, daemon=True)
                    finalize_thread.start()
                    
                    # Pipeline completed successfully - no container reset needed
                    # The backup branch doesn't force container restarts, allowing the container to stay running
                    # This prevents Railway from logging crashes and allows the container to handle multiple runs
                    pipeline_runs[run_id]["progress"] = 100
            else:
                pass
        
        except FileNotFoundError as e:
            # State file not found
            error_msg = f"State file not found. Please ensure assets/data/state_counties/{state.lower().replace(' ', '_')}.txt exists in the repository."
            # Only update pipeline_runs if run_id still exists (may have been cleaned up)
            if run_id in pipeline_runs:
                pipeline_runs[run_id]["status"] = "error"
                pipeline_runs[run_id]["error"] = error_msg
                pipeline_runs[run_id]["statusMessage"] = f"Pipeline failed: {error_msg}"
            import traceback
            traceback.print_exc()
        except Exception as e:
            # Any other error - save checkpoint before exiting
            error_msg = str(e)[:500]  # Limit error message length
            import traceback
            traceback.print_exc()
            
            # Try to save checkpoint with current progress
            try:
                checkpoint = load_checkpoint(run_id)
                if checkpoint:
                    completed_counties = checkpoint.get("completed_counties", [])
                    total_counties = checkpoint.get("total_counties", 0)
                    if len(completed_counties) > 0:
                        save_checkpoint(run_id, state, completed_counties, len(completed_counties), total_counties)
            except Exception as checkpoint_error:
                pass
            
            # Only update pipeline_runs if run_id still exists (may have been cleaned up)
            if run_id in pipeline_runs:
                pipeline_runs[run_id]["status"] = "error"
                pipeline_runs[run_id]["error"] = error_msg
                pipeline_runs[run_id]["statusMessage"] = f"Pipeline failed: {error_msg}"
    
    # Wrapper to ensure thread always completes and updates status
    def process_all_counties_with_error_handling():
        try:
            process_all_counties()
        except Exception as e:
            import traceback
            traceback.print_exc()
            # Ensure status is updated even on unhandled exceptions
            if run_id in pipeline_runs:
                pipeline_runs[run_id]["status"] = "error"
                pipeline_runs[run_id]["error"] = f"Unhandled exception: {str(e)}"
                pipeline_runs[run_id]["statusMessage"] = f"Pipeline crashed: {str(e)}"
        finally:
            if pipeline_runs.get(run_id, {}).get("queue_job_id") is not None:
                pst = pipeline_runs.get(run_id, {}).get("status", "error")
                perr = pipeline_runs.get(run_id, {}).get("error")
                try:
                    queue_store.queue_finalize(run_id, SCRAPER_TYPE, str(pst), perr)
                except Exception as qe:
                    pass
            # Always clean up thread tracking
            if run_id in running_threads:
                # Don't remove, just mark as not running
                running_threads[run_id]['cancelled'] = True
    
    # Start processing in a background thread
    # Note: daemon=True means thread dies if main process exits, but we save checkpoints
    # so progress is preserved even if container restarts
    thread = threading.Thread(target=process_all_counties_with_error_handling)
    thread.daemon = True
    
    # Track the thread for cancellation
    running_threads[run_id] = {'thread': thread, 'cancelled': False}
    
    thread.start()


@app.route("/", methods=["GET"])
def root():
    """Root endpoint"""
    return jsonify({
        "status": "ok",
        "service": "School Scraper API",
        "endpoints": {
            "health": "/health",
            "notify-test-email": "/notify/test-email (POST, auth)",
            "run-pipeline": "/run-pipeline (POST)",
            "pipeline-status": "/pipeline-status/<run_id> (GET)"
        }
    }), 200


@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    """Health check endpoint - public, no authentication required"""
    # Flask-CORS handles CORS headers automatically, but we can add explicit headers if needed
    response = jsonify({"status": "healthy"})
    return response, 200


@app.route("/notify/test-email", methods=["POST", "OPTIONS"])
@require_auth
def notify_test_email():
    """Send a dummy email via Resend to NOTIFY_EMAIL (no scrape). Auth required."""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    r = send_test_notification_email("School Scraper")
    if r.get("ok"):
        resp = jsonify({
            "status": "ok",
            "message": "Test email sent to NOTIFY_EMAIL (check inbox and spam).",
        })
        resp.headers.add("Access-Control-Allow-Origin", "*")
        return resp, 200
    err = jsonify({"status": "error", "error": r.get("error", "Unknown error")})
    err.headers.add("Access-Control-Allow-Origin", "*")
    return err, 400


@app.route("/debug/volume", methods=["GET", "OPTIONS"])
@require_auth
def debug_volume():
    """List /data (persistent volume) contents - runs, CSVs, metadata. Auth required."""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        return response, 200
    try:
        data_path = Path(os.getenv("PERSISTENT_DATA_DIR", "/data"))
        if not data_path.exists():
            return jsonify({
                "path": str(data_path),
                "exists": False,
                "error": "Path does not exist"
            }), 200
        entries = []
        total_size = 0
        file_count = 0
        csv_files = []
        for item in sorted(data_path.iterdir()):
            try:
                if item.is_dir():
                    sub_count = 0
                    sub_size = 0
                    sub_csvs = []
                    for sub in sorted(item.iterdir()):
                        try:
                            if sub.is_file():
                                sub_count += 1
                                sz = sub.stat().st_size
                                sub_size += sz
                                if sub.suffix.lower() == ".csv":
                                    sub_csvs.append({"name": sub.name, "size": sz})
                            elif sub.is_dir():
                                sub_count += 1
                                for f in sub.rglob("*"):
                                    if f.is_file():
                                        sub_count += 1
                                        sz = f.stat().st_size
                                        sub_size += sz
                                        if f.suffix.lower() == ".csv":
                                            sub_csvs.append({"name": f.name, "path": str(f.relative_to(data_path)), "size": sz})
                        except OSError:
                            pass
                    entries.append({
                        "name": item.name,
                        "type": "dir",
                        "entries": sub_count,
                        "size_bytes": sub_size,
                        "size_mb": round(sub_size / (1024 * 1024), 2),
                        "csvs": sub_csvs[:20]
                    })
                    total_size += sub_size
                    file_count += sub_count
                else:
                    sz = item.stat().st_size
                    total_size += sz
                    file_count += 1
                    entries.append({
                        "name": item.name,
                        "type": "file",
                        "size_bytes": sz,
                        "size_mb": round(sz / (1024 * 1024), 2)
                    })
                    if item.suffix.lower() == ".csv":
                        csv_files.append({"name": item.name, "size": sz})
            except OSError as e:
                entries.append({"name": item.name, "error": str(e)})
        return jsonify({
            "path": str(data_path),
            "exists": True,
            "entries": entries,
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "file_count": file_count,
            "csv_files": csv_files[:50]
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# Rate limiting for login endpoint (simple in-memory implementation)
login_attempts = {}
LOGIN_RATE_LIMIT = 5  # Max attempts per IP
LOGIN_RATE_WINDOW = 300  # 5 minutes in seconds

def check_rate_limit(ip_address: str) -> bool:
    """Check if IP has exceeded rate limit"""
    current_time = time.time()
    if ip_address not in login_attempts:
        login_attempts[ip_address] = []
    
    # Clean old attempts
    login_attempts[ip_address] = [
        attempt_time for attempt_time in login_attempts[ip_address]
        if current_time - attempt_time < LOGIN_RATE_WINDOW
    ]
    
    # Check if limit exceeded
    if len(login_attempts[ip_address]) >= LOGIN_RATE_LIMIT:
        return False
    
    # Record this attempt
    login_attempts[ip_address].append(current_time)
    return True


@app.route("/login", methods=["POST", "OPTIONS"])
def login():
    """Login endpoint - authenticate user and return JWT token"""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    try:
        # Rate limiting
        client_ip = request.remote_addr or "unknown"
        if not check_rate_limit(client_ip):
            return jsonify({
                "status": "error",
                "error": "Too many login attempts. Please try again later."
            }), 429
        
        data = request.get_json() or {}
        username = data.get("username", "").strip()
        password = data.get("password", "")
        
        if not username or not password:
            return jsonify({
                "status": "error",
                "error": "Username and password are required"
            }), 400
        
        # Verify credentials
        if not verify_password(username, password):
            return jsonify({
                "status": "error",
                "error": "Invalid username or password"
            }), 401
        
        # Generate token
        token = generate_token(username)
        
        response = jsonify({
            "status": "success",
            "token": token,
            "username": username
        })
        response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
        return response, 200
        
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
        return error_response, 500


@app.route("/run-pipeline", methods=["POST", "OPTIONS"])
@require_auth
def run_pipeline():
    """Start the pipeline and return run ID for status polling"""
    # Flask-CORS handles OPTIONS preflight requests automatically
    # But we need to ensure OPTIONS returns early to avoid hitting POST validation
    if request.method == "OPTIONS":
        # Flask-CORS will add the headers automatically
        return jsonify({}), 200
    
    # Ensure POST method (should never reach here for OPTIONS since handled above)
    if request.method != "POST":
        return jsonify({
            "status": "error",
            "error": f"Method {request.method} not allowed. Use POST.",
            "received_method": request.method,
            "allowed_methods": ["POST"]
        }), 405
    
    try:
        data = request.get_json() or {}
        state = data.get("state", "").lower()
        type_param = data.get("type", "school")
        
        if not state:
            return jsonify({
                "status": "error",
                "error": "State parameter is required"
            }), 400
        
        if type_param == "church":
            return jsonify({
                "status": "error",
                "error": "This is the School scraper. Use type=school"
            }), 400
        
        # Check if another run for the SAME STATE is already active or finalizing
        # Allow concurrent runs for DIFFERENT states (supports 2 states with 3 workers each)
        active_runs_same_state = []
        finalizing_runs_same_state = []
        active_runs_all_states = []  # Track all active runs for cap enforcement
        current_time = time.time()
        
        for rid, run_data in pipeline_runs.items():
            run_state = run_data.get("state", "").lower()
            status = run_data.get("status")
            
            # Check for running runs (all states - for cap enforcement)
            if status == "running":
                # Verify thread is actually alive
                if rid in running_threads:
                    thread = running_threads[rid].get('thread')
                    if thread and thread.is_alive():
                        active_runs_all_states.append(rid)
                        # Also track same-state runs
                        if run_state == state:
                            active_runs_same_state.append(rid)
                else:
                    # Thread missing but status is running - mark as stale
                    pipeline_runs[rid]["status"] = "cancelled"
            
            # Check for finalizing runs (2-minute cooldown)
            elif status == "finalizing":
                finalizing_at = run_data.get("finalizingAt", 0)
                elapsed = current_time - finalizing_at
                if elapsed < 120:  # Still in 2-minute cooldown
                    if run_state == state:
                        finalizing_runs_same_state.append(rid)
                else:
                    # Cooldown expired, mark as completed
                    pipeline_runs[rid]["status"] = "completed"
                    if "completedAt" not in pipeline_runs[rid]:
                        pipeline_runs[rid]["completedAt"] = current_time
        
        # Enforce maximum 2 concurrent states cap
        unique_active_states = set()
        for rid in active_runs_all_states:
            if rid in pipeline_runs:
                run_state = pipeline_runs[rid].get("state", "").lower()
                if run_state:
                    unique_active_states.add(run_state)
        
        if active_runs_same_state:
            return jsonify({
                "status": "error",
                "error": f"Another run for {state} is already in progress. Please wait for it to complete or stop it first.",
                "activeRunId": active_runs_same_state[0],
                "state": state
            }), 409  # Conflict status code
        
        if finalizing_runs_same_state:
            return jsonify({
                "status": "error",
                "error": f"A run for {state} is currently finalizing. Please wait 2 minutes before starting a new run for this state.",
                "activeRunId": finalizing_runs_same_state[0],
                "isFinalizing": True,
                "state": state
            }), 409  # Conflict status code
        
        if state.lower() not in unique_active_states and len(unique_active_states) >= 1:
            if db.is_postgres():
                dn = _run_display_name(state, SCRAPER_TYPE)
                q = queue_store.queue_enqueue(state, SCRAPER_TYPE, dn)
                resp = jsonify({
                    "status": "queued",
                    "jobId": q["job_id"],
                    "position": q["position"],
                    "message": f"Queued: {len(unique_active_states)} states already running ({', '.join(sorted(unique_active_states))})",
                    "activeStates": sorted(unique_active_states),
                })
                resp.headers.add("Access-Control-Allow-Origin", "*")
                return resp, 202
            return jsonify({
                "status": "error",
                "error": f"Maximum of 2 concurrent states allowed. Currently running: {', '.join(sorted(unique_active_states))}. Please wait for one to complete.",
                "activeStates": sorted(unique_active_states),
                "maxConcurrentStates": 2
            }), 409  # Conflict status code
        
        # Generate unique run ID
        run_id = str(uuid.uuid4())
        
        # Start pipeline in background thread
        thread = threading.Thread(target=run_streaming_pipeline, args=(state, run_id, False, None))
        thread.daemon = True
        thread.start()
        
        # Return run ID immediately
        response = jsonify({
            "status": "started",
            "runId": run_id,
            "message": "Pipeline started"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
        
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/queue", methods=["GET", "OPTIONS"])
@require_auth
def school_queue_list():
    """List SQLite queue jobs for this scraper (requires SQLITE_PATH)."""
    if request.method == "OPTIONS":
        r = jsonify({})
        r.headers.add("Access-Control-Allow-Origin", "*")
        r.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        r.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        return r, 200
    jobs = queue_store.queue_list_jobs(SCRAPER_TYPE)
    resp = jsonify({"status": "ok", "jobs": jobs, "count": len(jobs)})
    resp.headers.add("Access-Control-Allow-Origin", "*")
    return resp, 200


@app.route("/queue/<int:job_id>", methods=["DELETE", "OPTIONS"])
@require_auth
def school_queue_cancel(job_id: int):
    """Cancel a queued (not yet running) job."""
    if request.method == "OPTIONS":
        r = jsonify({})
        r.headers.add("Access-Control-Allow-Origin", "*")
        r.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        r.headers.add("Access-Control-Allow-Methods", "DELETE, OPTIONS")
        return r, 200
    ok = queue_store.queue_cancel_job(job_id, SCRAPER_TYPE)
    if not ok:
        return jsonify({
            "status": "error",
            "error": "Job not found or not in queued status",
            "jobId": job_id,
        }), 404
    resp = jsonify({"status": "ok", "message": "Job cancelled", "jobId": job_id})
    resp.headers.add("Access-Control-Allow-Origin", "*")
    return resp, 200


# Removed /process-county endpoint - no longer needed with multiprocessing pool approach


@app.route("/pipeline-status/<run_id>", methods=["GET"])
@require_auth
def pipeline_status(run_id):
    """Get status of a running pipeline"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    if run_id in pipeline_runs:
        run_data = pipeline_runs[run_id].copy()
    elif (syn := _synthetic_pipeline_status_from_dispatch(run_id)):
        run_data = syn
    else:
        # Track repeated 404 requests to prevent spam from stale browser tabs
        current_time = time.time()
        if run_id in not_found_runs:
            first_time, count = not_found_runs[run_id]
            if count >= 3 and (current_time - first_time) < 30:
                return jsonify({
                    "status": "error",
                    "error": "Run ID not found. This run no longer exists."
                }), 410
            not_found_runs[run_id] = (first_time, count + 1)
        else:
            not_found_runs[run_id] = (current_time, 1)

        to_remove = [rid for rid, (ft, _) in not_found_runs.items() if current_time - ft > 300]
        for rid in to_remove:
            not_found_runs.pop(rid, None)

        return jsonify({
            "status": "error",
            "error": "Run ID not found"
        }), 404
    
    # If run is completed, return 410 Gone after grace period to stop polling
    # Allow a 2-minute grace period for the final status fetch, then return 410 Gone
    if run_data.get("status") == "completed":
        completed_time = run_data.get("completedAt")
        if completed_time:
            time_since_completion = time.time() - completed_time
            if time_since_completion > 120:  # 2 minutes grace period, then return 410 Gone
                # Clean up old completed runs from memory (older than 1 hour)
                if time_since_completion > 3600:  # 1 hour
                    pipeline_runs.pop(run_id, None)
                return jsonify({
                    "status": "completed",
                    "message": "Run completed. Status no longer available."
                }), 410  # Gone status code
    
    # Calculate server-side elapsed time
    start_time = run_data.get("startTime")
    if start_time:
        elapsed_seconds = time.time() - start_time
        run_data["elapsedTime"] = int(elapsed_seconds)
    else:
        run_data["elapsedTime"] = 0
    
    # Calculate static estimated time remaining (ticks down minute by minute)
    # Estimate is calculated once at start and decreases as time passes
    if run_data["status"] == "running":
        initial_estimate = run_data.get("initialEstimatedTimeRemaining")
        elapsed_seconds = run_data.get("elapsedTime", 0)
        
        if initial_estimate is not None and initial_estimate > 0:
            # Calculate remaining as initial estimate minus elapsed time
            remaining_seconds = max(0, initial_estimate - elapsed_seconds)
            # Round to minutes (no seconds) - round up to nearest minute for display
            remaining_minutes = int((remaining_seconds + 59) // 60)  # Round up to nearest minute
            run_data["estimatedTimeRemaining"] = remaining_minutes * 60  # Convert back to seconds for consistency
        else:
            # Fallback: calculate dynamically if initial estimate not set (for old runs)
            counties_processed = run_data.get("countiesProcessed", 0)
            total_counties = run_data.get("totalCounties", 0)
            
            if total_counties > 0:
                remaining_counties = max(0, total_counties - counties_processed)
                avg_time_per_county = 871  # 14.5 minutes average from log analysis
                effective_remaining = max(1, remaining_counties / MAX_WORKERS)
                estimated_remaining = effective_remaining * avg_time_per_county
                # Round to minutes
                remaining_minutes = int((estimated_remaining + 59) // 60)
                run_data["estimatedTimeRemaining"] = remaining_minutes * 60
            else:
                run_data["estimatedTimeRemaining"] = 0
    else:
        run_data["estimatedTimeRemaining"] = 0
    
    response = jsonify(run_data)
    response.headers.add("Access-Control-Allow-Origin", "*")
    return response, 200


# Error handler for 405 Method Not Allowed
@app.errorhandler(405)
def method_not_allowed(e):
    response = jsonify({
        "status": "error",
        "error": f"Method not allowed: {request.method}",
        "path": request.path,
        "received_method": request.method,
        "allowed_methods": ["POST", "OPTIONS"] if "/run-pipeline" in request.path else ["GET"]
    })
    response.headers.add("Access-Control-Allow-Origin", ALLOWED_ORIGIN if ALLOWED_ORIGIN != "*" else "*")
    if "/run-pipeline" in request.path:
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
    return response, 405

# Error handler for 404 Not Found
@app.route("/runs", methods=["GET", "OPTIONS"])
@require_auth
def list_runs():
    """List all runs from persistent storage"""
    # Flask-CORS handles OPTIONS preflight requests automatically
    if request.method == "OPTIONS":
        return jsonify({}), 200
    
    try:
        runs = list_all_runs()
        # Merge in runs from Postgres that may not have filesystem metadata
        try:
            db_runs = queue_store.list_runs(SCRAPER_TYPE, include_archived=True)
            existing_ids = {r.get("run_id") for r in runs}
            for db_row in db_runs:
                if db_row["run_id"] not in existing_ids:
                    runs.append(queue_store.row_to_list_format(db_row))
        except Exception as e:
            pass

        # Sort by created_at (newest first)
        runs.sort(key=lambda x: x.get("created_at", ""), reverse=True)

        # Format response
        response_data = {
            "status": "ok",
            "runs": runs,
            "count": len(runs)
        }

        # Flask-CORS will add CORS headers automatically
        response = jsonify(response_data)
        return response, 200
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        # Flask-CORS will add CORS headers automatically
        return error_response, 500


@app.route("/runs/<run_id>/stop", methods=["POST", "OPTIONS"])
@require_auth
def stop_run(run_id: str):
    """Stop a running pipeline"""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        # Check metadata first (persistent storage)
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        # Check if run is actually running
        current_status = metadata.get("status", pipeline_runs.get(run_id, {}).get("status", "unknown"))
        if current_status != "running":
            return jsonify({
                "status": "error",
                "error": f"Run is not running (current status: {current_status})"
            }), 400
        
        # Set cancellation flag
        if run_id in running_threads:
            running_threads[run_id]['cancelled'] = True

        # Update in-memory status if present
        if run_id in pipeline_runs:
            pipeline_runs[run_id]["status"] = "cancelled"
            pipeline_runs[run_id]["statusMessage"] = "Pipeline cancelled by user"

        # Update Postgres state
        queue_store.update_run(run_id, status="cancelled", status_message="Pipeline cancelled by user",
                           cancelled_at=datetime.now().isoformat())
        queue_store.cancel_dispatch(run_id)

        # Update metadata
        metadata.update({
            "status": "cancelled",
            "cancelled_at": datetime.now().isoformat()
        })
        save_run_metadata(run_id, metadata)

        
        response = jsonify({
            "status": "success",
            "message": "Pipeline stop requested"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/runs/<run_id>/resume", methods=["POST", "OPTIONS"])
@require_auth
def resume_run(run_id: str):
    """Resume a run from checkpoint. Loads checkpoint and skips counties that have data files."""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        # Check metadata first (persistent storage)
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        state = metadata.get("state")
        if not state:
            return jsonify({
                "status": "error",
                "error": "State not found in run metadata"
            }), 400
        
        # Check if another run for the SAME STATE is currently running
        # Allow concurrent runs for DIFFERENT states
        state_lower = state.lower()
        active_runs_same_state = []
        
        for rid, run_data in pipeline_runs.items():
            run_state = run_data.get("state", "").lower()
            run_status = run_data.get("status")
            
            # Only check runs for the same state (skip the run we're trying to resume)
            if rid == run_id or run_state != state_lower:
                continue
            
            # Check for running runs
            if run_status == "running":
                # Verify thread is actually alive
                if rid in running_threads:
                    thread = running_threads[rid].get('thread')
                    if thread and thread.is_alive():
                        active_runs_same_state.append(rid)
        
        if active_runs_same_state:
            return jsonify({
                "status": "error",
                "error": f"Another run for {state} is already running. Please stop it first before resuming.",
                "activeRunId": active_runs_same_state[0],
                "state": state
            }), 409  # Conflict
        
        # Check if THIS run is currently running
        if run_id in pipeline_runs and pipeline_runs[run_id].get("status") == "running":
            # Check if thread is actually alive
            if run_id in running_threads:
                thread = running_threads[run_id].get('thread')
                if thread and thread.is_alive():
                    return jsonify({
                        "status": "error",
                        "error": "This run is already running. Please stop it first before resuming."
                    }), 409  # Conflict
        
        # Check if checkpoint exists
        checkpoint = load_checkpoint(run_id)
        if not checkpoint:
            return jsonify({
                "status": "error",
                "error": "No checkpoint found for this run. Cannot resume."
            }), 400
        
        # Check if already completed
        completed_counties = checkpoint.get('completed_counties', [])
        total_counties = checkpoint.get('total_counties', 0)
        if len(completed_counties) >= total_counties:
            return jsonify({
                "status": "error",
                "error": "Run is already complete. Cannot resume."
            }), 400
        
        # Start pipeline with resume flag
        thread = threading.Thread(target=run_streaming_pipeline, args=(state, run_id, True, None))
        thread.daemon = True
        
        # Track the thread for cancellation
        running_threads[run_id] = {'thread': thread, 'cancelled': False}
        
        thread.start()
        
        response = jsonify({
            "status": "resumed",
            "runId": run_id,
            "message": f"Run resumed from checkpoint: {len(completed_counties)}/{total_counties} counties already completed"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
        
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/runs/<run_id>/aggregate", methods=["POST", "OPTIONS"])
@require_auth
def aggregate_run(run_id: str):
    """Manually trigger aggregation for a run, skipping wait for incomplete counties."""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        # Check metadata first (persistent storage)
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        state = metadata.get("state")
        if not state:
            return jsonify({
                "status": "error",
                "error": "State not found in run metadata"
            }), 400
        
        # Check if run is already aggregating or completed
        if run_id in pipeline_runs:
            current_status = pipeline_runs[run_id].get("status")
            if current_status == "finalizing":
                return jsonify({
                    "status": "error",
                    "error": "Run is already finalizing/aggregating. Please wait."
                }), 409
            elif current_status == "completed":
                return jsonify({
                    "status": "error",
                    "error": "Run is already completed."
                }), 409
        
        # Check if run directory exists
        run_dir = RUNS_DIR / run_id
        if not run_dir.exists():
            return jsonify({
                "status": "error",
                "error": "Run directory not found"
            }), 404
        
        # Initialize run status if not already in pipeline_runs
        if run_id not in pipeline_runs:
            pipeline_runs[run_id] = {
                "status": "finalizing",
                "state": state.lower(),
                "statusMessage": "Manually triggering aggregation...",
                "startTime": metadata.get("start_time", time.time())
            }
        else:
            pipeline_runs[run_id]["status"] = "finalizing"
            pipeline_runs[run_id]["statusMessage"] = "Manually triggering aggregation..."
        
        # Run aggregation in background thread with skip_wait=True
        def run_aggregation():
            try:
                aggregate_final_results(run_id, state, skip_wait=True)
            except Exception as e:
                import traceback
                traceback.print_exc()
                if run_id in pipeline_runs:
                    pipeline_runs[run_id]["status"] = "error"
                    pipeline_runs[run_id]["error"] = f"Aggregation failed: {str(e)}"
                    pipeline_runs[run_id]["statusMessage"] = f"Failed to aggregate: {str(e)}"
        
        aggregation_thread = threading.Thread(target=run_aggregation, daemon=True)
        aggregation_thread.start()
        
        response = jsonify({
            "status": "aggregating",
            "runId": run_id,
            "state": state,
            "message": "Aggregation started. This will proceed with available county data, skipping incomplete counties."
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
        
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/runs/<run_id>/delete", methods=["DELETE", "OPTIONS"])
@require_auth
def delete_run(run_id: str):
    """Delete a run - marks as deleted in metadata instead of actually deleting files.
    If run is running, stops it first."""
    if request.method == "OPTIONS":
        response = jsonify({})
        # CORS preflight: allow auth header for DELETE requests
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "DELETE, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        # Load metadata to check if run exists
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        # If run is running, stop it first
        status = metadata.get("status")
        if status == "running":
            # Set cancellation flag to stop the run
            if run_id in running_threads:
                running_threads[run_id]['cancelled'] = True
            
            # Update in-memory status if present
            if run_id in pipeline_runs:
                pipeline_runs[run_id]["status"] = "cancelled"
                pipeline_runs[run_id]["statusMessage"] = "Pipeline cancelled by user"
            
            # Update Postgres state
            queue_store.update_run(run_id, status="cancelled", status_message="Cancelled for deletion",
                               cancelled_at=datetime.now().isoformat())
            queue_store.cancel_dispatch(run_id)

            # Update metadata to cancelled first
            metadata["status"] = "cancelled"
            metadata["cancelled_at"] = datetime.now().isoformat()
        
        # Actually delete files (ephemeral + volume final CSV)
        run_dir = RUNS_DIR / run_id
        checkpoint_file = CHECKPOINTS_DIR / f"{run_id}.json"

        try:
            # Delete ephemeral run directory
            if run_dir.exists():
                shutil.rmtree(run_dir)

            # Delete checkpoint file if it exists
            if checkpoint_file.exists():
                checkpoint_file.unlink()

            # Delete final CSV from volume if it exists
            final_csv_path = metadata.get("final_csv_path")
            if final_csv_path and Path(final_csv_path).exists():
                try:
                    Path(final_csv_path).unlink()
                except Exception:
                    pass
        except Exception as e:
            pass

        # Mark as deleted in metadata
        metadata["deleted"] = True
        metadata["deleted_at"] = datetime.now().isoformat()
        save_run_metadata(run_id, metadata)

        # Mark as deleted in Postgres
        queue_store.delete_run(run_id)

        # Remove from in-memory storage if present
        pipeline_runs.pop(run_id, None)
        running_threads.pop(run_id, None)

        
        response = jsonify({
            "status": "success",
            "message": "Run deleted successfully"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/runs/<run_id>/archive", methods=["POST", "OPTIONS"])
@require_auth
def archive_run(run_id: str):
    """Archive a completed run"""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        # Cannot archive deleted runs
        if metadata.get("deleted", False):
            return jsonify({
                "status": "error",
                "error": "Cannot archive a deleted run"
            }), 400
        
        # Update metadata to mark as archived
        metadata["archived"] = True
        save_run_metadata(run_id, metadata)

        # Update Postgres
        queue_store.update_run(run_id, archived=True)

        
        response = jsonify({
            "status": "success",
            "message": "Run archived successfully"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/runs/<run_id>/unarchive", methods=["POST", "OPTIONS"])
@require_auth
def unarchive_run(run_id: str):
    """Unarchive a run"""
    if request.method == "OPTIONS":
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        return response, 200
    
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        # Cannot unarchive deleted runs
        if metadata.get("deleted", False):
            return jsonify({
                "status": "error",
                "error": "Cannot unarchive a deleted run"
            }), 400
        
        # Update metadata to remove archived flag
        metadata["archived"] = False
        save_run_metadata(run_id, metadata)

        # Update Postgres
        queue_store.update_run(run_id, archived=False)

        
        response = jsonify({
            "status": "success",
            "message": "Run unarchived successfully"
        })
        response.headers.add("Access-Control-Allow-Origin", "*")
        return response, 200
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.route("/admin/upload-csv", methods=["POST"])
@require_auth
def admin_upload_csv():
    """Upload a CSV file to the persistent volume (for recovery/restore)."""
    try:
        data = request.get_json(force=True)
        filename = data.get("filename", "").strip()
        content = data.get("content", "")
        if not filename or not content:
            return jsonify({"status": "error", "error": "filename and content required"}), 400
        safe_name = Path(filename).name
        if not safe_name.endswith(".csv"):
            return jsonify({"status": "error", "error": "filename must end with .csv"}), 400
        dest = VOLUME_DIR / safe_name
        with open(dest, "w") as f:
            f.write(content)
        return jsonify({"status": "ok", "path": str(dest), "size": len(content)}), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/runs/<run_id>/download", methods=["GET"])
@require_auth
def download_run_csv(run_id: str):
    """Download the final CSV for a completed run"""
    # Security: Validate run_id to prevent path traversal
    if not validate_run_id(run_id):
        return jsonify({
            "status": "error",
            "error": "Invalid run ID format"
        }), 400
    
    try:
        # Load metadata to get CSV path
        metadata = load_run_metadata(run_id)
        if not metadata:
            return jsonify({
                "status": "error",
                "error": "Run not found"
            }), 404
        
        # Get CSV path from metadata or construct it
        csv_path = metadata.get("final_csv_path")
        if not csv_path:
            # Try to construct path
            state = metadata.get("state", "").title()
            run_dir = RUNS_DIR / run_id
            csv_path = str(run_dir / f"{state}_leads_final.csv")
        
        # Check if file exists
        if not os.path.exists(csv_path):
            return jsonify({
                "status": "error",
                "error": "CSV file not found for this run"
            }), 404
        
        # Read and return CSV
        from flask import send_file
        return send_file(
            csv_path,
            mimetype='text/csv',
            as_attachment=True,
            download_name=metadata.get("csv_filename", f"run_{run_id}.csv")
        )
    except Exception as e:
        error_response = jsonify({
            "status": "error",
            "error": str(e)
        })
        error_response.headers.add("Access-Control-Allow-Origin", "*")
        return error_response, 500


@app.errorhandler(404)
def not_found(e):
    return jsonify({
        "status": "error",
        "error": f"Endpoint not found: {request.path}",
        "available_endpoints": ["/", "/health", "/debug/volume", "/notify/test-email", "/run-pipeline", "/queue", "/queue/<job_id>", "/pipeline-status/<run_id>", "/runs", "/runs/<run_id>/download", "/runs/<run_id>/stop", "/runs/<run_id>/delete", "/runs/<run_id>/resume", "/runs/<run_id>/archive", "/runs/<run_id>/unarchive"]
    }), 404

# --- Bootstrap: role-based startup ---
_bootstrap_lock = threading.Lock()
_bootstrap_done = False


def _ensure_api_bootstrap() -> None:
    global _bootstrap_done
    with _bootstrap_lock:
        if _bootstrap_done:
            return
        _bootstrap_done = True
        log_warn(f"Bootstrap: ROLE={ROLE} PID={os.getpid()} HOST={socket.gethostname()}")
        _repair_stuck_metadata()
        cleanup_old_runs()
        queue_store.init_tables()
        if IS_MANAGER:
            log_warn("Manager mode: starting queue worker (0 county workers)")
            threading.Thread(target=_school_queue_worker_loop, daemon=True).start()
        elif IS_WORKER:
            n_proc = max(1, WORKERS_PER_REPLICA)
            log_warn(f"Worker mode: starting {n_proc} county processor(s)")
            try:
                queue_store.release_stale_claims(socket.gethostname())
            except Exception as e:
                log_warn(f"Crash recovery failed: {e}")
            for _i in range(n_proc):
                _tag = f"{_SCHOOL_PROCESS_ID}-w{_i}"
                threading.Thread(
                    target=_county_processor_worker_loop,
                    args=(_tag,),
                    daemon=True,
                ).start()


_ensure_api_bootstrap()

# Production: Use Waitress server
# NOTE: If Railway runs this file directly (bypassing Dockerfile ENTRYPOINT),
# we need to exec into dumb-init ourselves to ensure proper process reaping.
if __name__ == "__main__":
    import subprocess
    import sys
    import os
    
    # Check if dumb-init is PID 1 (it should be if Dockerfile ENTRYPOINT is respected)
    needs_dumb_init = False
    if HAS_PSUTIL:
        try:
            pid1 = psutil.Process(1)
            pid1_name = pid1.name().lower()
            if 'dumb-init' not in pid1_name and 'init' not in pid1_name:
                needs_dumb_init = True
        except:
            pass  # Can't verify, continue anyway
    
    # If dumb-init is not PID 1, exec into it with waitress-serve as the command
    # This ensures dumb-init becomes PID 1 and properly reaps zombie processes
    # Do this silently - no warning messages
    if needs_dumb_init:
        # Find dumb-init
        dumb_init_path = None
        for path in ['/usr/bin/dumb-init', '/usr/local/bin/dumb-init', '/bin/dumb-init']:
            if os.path.exists(path) and os.access(path, os.X_OK):
                dumb_init_path = path
                break
        
        if dumb_init_path:
            port = os.environ.get("PORT", "8080")
            # Exec into dumb-init silently - no log messages
            # This replaces the current Python process with dumb-init, which then runs waitress
            os.execv(dumb_init_path, [
                dumb_init_path, '--',
                'waitress-serve',
                '--host=0.0.0.0',
                f'--port={port}',
                '--threads=4',
                '--channel-timeout=300',
                'external_services.api:app'
            ])
        # If dumb-init not found, fall through to regular startup (but this shouldn't happen)
    
    # If we reach here, either dumb-init is already PID 1, or we couldn't find it
    port = os.environ.get("PORT", "8080")
    # Start Waitress silently - no startup messages
    subprocess.run([
        sys.executable, "-m", "waitress",
        "--host=0.0.0.0",
        f"--port={port}",
        "--threads=4",
        "--channel-timeout=300",
        "external_services.api:app"
    ])
