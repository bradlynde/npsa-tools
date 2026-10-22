"""
Operational logging for School Contact Scraper (stdout).
Minimal Version C format: boot once, one line per county, failures, summary box.

Pool workers send lines through a multiprocessing.Queue so the main process prints
one line at a time (no interleaving). Main process prints directly with flush=True
so the startup banner appears before worker output when stdout is piped (Railway).
"""

from __future__ import annotations

import os
import threading
from typing import Any, Optional

W = 55

# Set in Pool worker processes via configure_worker_log_queue (main stays None).
_worker_log_queue: Optional[Any] = None

# Serialize stdout from the drain thread and the main thread.
_print_lock = threading.Lock()


def configure_worker_log_queue(q: Any) -> None:
    """Pool initializer: send all structured log lines through this queue."""
    global _worker_log_queue
    _worker_log_queue = q


def clear_worker_log_queue() -> None:
    """Reset after pool shutdown (main process)."""
    global _worker_log_queue
    _worker_log_queue = None


def start_stdout_drain_thread(q: Any) -> threading.Thread:
    """Main process: one thread reads log lines from workers and prints with flush."""

    def _drain() -> None:
        while True:
            line = q.get()
            if line is None:
                break
            with _print_lock:
                print(line, flush=True)

    t = threading.Thread(target=_drain, name="school-scraper-log-drain", daemon=True)
    t.start()
    return t


def _emit(line: str) -> None:
    wq = _worker_log_queue
    if wq is not None:
        wq.put(line)
    else:
        with _print_lock:
            print(line, flush=True)


# ---------------------------------------------------------------------------
# Boot — called once on container startup
# ---------------------------------------------------------------------------

def log_boot(role: str = "worker") -> None:
    _emit("- Booting -")
    _emit(f"  School Scraper | {role}")
    _emit("- All Systems Operational -")


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

def log_run_start(state: str, counties: int, workers: int) -> None:
    st = state.replace("_", " ").title()
    _emit(f"School Scraper | {st} | {counties} counties | {workers} workers")


def log_county(county: str, contacts: int, with_email: int, minutes: float) -> None:
    _emit(f"[{county}] {contacts} contacts ({with_email} email) - {minutes:.0f} min")


def log_county_fail(county: str, reason: str) -> None:
    short = reason[:120] if len(reason) > 120 else reason
    _emit(f"! [{county}] FAILED - {short}")


def log_progress(completed: int, total: int, contacts: int) -> None:
    _emit(f"-- {completed}/{total} counties - {contacts} contacts --")


def log_complete(
    state: str,
    completed: int,
    total: int,
    hours: float,
    contacts: int,
    csv_filename: str,
) -> None:
    bar = "=" * W
    st = state.replace("_", " ").title()
    _emit(bar)
    _emit(f"  {st} Complete - {completed}/{total} - {hours:.1f} hrs")
    _emit(f"  {contacts:,} contacts -> {csv_filename}")


def log_cost(
    places_calls: int,
    hunter_credits: int,
    openai_calls: int,
    openai_input_tokens: int,
    openai_output_tokens: int,
    elapsed_hours: float,
    total_contacts: int,
) -> None:
    billable_places = max(0, places_calls - 1000)
    places_cost = billable_places * (35.0 / 1000.0)
    hunter_cost = hunter_credits * (50.0 / 1000.0)
    # Claude Haiku 5.5 rates ($/MTok, prompts <= 100K tokens). The openai_* names
    # are kept because they match the stored stats/DB fields.
    openai_cost = (openai_input_tokens / 1_000_000.0) * 0.10 + (
        openai_output_tokens / 1_000_000.0
    ) * 0.50
    railway_cost = elapsed_hours * 60.0 * 0.000463
    total_cost = places_cost + hunter_cost + openai_cost + railway_cost
    per = (total_cost / total_contacts) if total_contacts else 0.0
    _emit(f"  ~${total_cost:.2f} - ${per:.3f}/contact")
    _emit("=" * W)


# ---------------------------------------------------------------------------
# Warnings / errors — kept minimal
# ---------------------------------------------------------------------------

def log_warn(msg: str) -> None:
    _emit(f"! {msg}")


def log_err(msg: str) -> None:
    _emit(f"X {msg}")
