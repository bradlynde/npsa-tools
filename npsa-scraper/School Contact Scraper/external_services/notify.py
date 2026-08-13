"""
Run-completion email notifications via Resend HTTP API (https://api.resend.com/emails).

Required: RESEND_API_KEY.
Optional: NOTIFY_EMAIL (comma-separated; defaults below), NOTIFY_FROM
(default onboarding@resend.dev), NOTIFY_ON_RUN_COMPLETE=false to disable.

The finished CSV is attached when one is available and small enough. Past
MAX_ATTACHMENT_BYTES the mail still goes, saying where to download instead —
a run that produced a lot of contacts is exactly when you want to be told.
"""

from __future__ import annotations

import base64
import html
import os
from typing import Any, Optional

import requests

RESEND_API_URL = "https://api.resend.com/emails"
SCRAPER_SUBJECT_TAG = "School Scraper"

# Whoever should get run notifications when NOTIFY_EMAIL is not set. Override
# with the env var — comma-separated for more than one — rather than editing
# this, so changing the recipient doesn't need a deploy.
DEFAULT_NOTIFY_EMAIL = "stuart@nonprofitsecurityadvisors.com"

# Resend caps total message size, and base64 inflates by 4/3. This sits well
# under that ceiling; a CSV bigger than this is more useful as a download.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


def _recipients() -> list[str]:
    raw = os.getenv("NOTIFY_EMAIL", "").strip() or DEFAULT_NOTIFY_EMAIL
    return [addr.strip() for addr in raw.split(",") if addr.strip()]


def _is_enabled() -> bool:
    """True if Resend + recipient are configured and notifications are not explicitly disabled."""
    if os.getenv("NOTIFY_ON_RUN_COMPLETE", "true").lower() in ("false", "0", "no"):
        return False
    return bool(os.getenv("RESEND_API_KEY", "").strip() and _recipients())


def _text_to_html(text: str) -> str:
    return (
        '<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">'
        f"{html.escape(text)}"
        "</pre>"
    )


def _read_attachment(csv_path: Optional[str]) -> tuple[Optional[dict[str, str]], Optional[str]]:
    """Return (resend_attachment, reason_it_was_skipped). Never raises."""
    if not csv_path:
        return None, None
    try:
        size = os.path.getsize(csv_path)
    except OSError as e:
        return None, f"the file could not be read ({e.__class__.__name__})"
    if size > MAX_ATTACHMENT_BYTES:
        mb = size / (1024 * 1024)
        return None, f"it is {mb:.1f} MB, too large to attach"
    try:
        with open(csv_path, "rb") as fh:
            data = fh.read()
    except OSError as e:
        return None, f"the file could not be read ({e.__class__.__name__})"
    return (
        {
            "filename": os.path.basename(csv_path),
            "content": base64.b64encode(data).decode("ascii"),
        },
        None,
    )


def _send_resend_html(
    subject: str,
    html_body: str,
    attachment: Optional[dict[str, str]] = None,
) -> None:
    """POST to Resend. Raises on configuration or API errors."""
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    to_emails = _recipients()
    from_addr = os.getenv("NOTIFY_FROM", "onboarding@resend.dev").strip()
    if not api_key or not to_emails:
        raise ValueError("Missing RESEND_API_KEY or NOTIFY_EMAIL")
    payload: dict[str, Any] = {
        "from": from_addr,
        "to": to_emails,
        "subject": subject,
        "html": html_body,
    }
    if attachment:
        payload["attachments"] = [attachment]
    try:
        r = requests.post(
            RESEND_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"Resend request failed: {e}") from e
    if not r.ok:
        raise RuntimeError(f"Resend API {r.status_code}: {r.text[:800]}")


def send_test_notification_email(service_label: str) -> dict[str, Any]:
    """
    Send a dummy email to NOTIFY_EMAIL to verify Resend without running a pipeline.

    Returns {"ok": True} or {"ok": False, "error": "..."}.
    """
    if not _is_enabled():
        return {
            "ok": False,
            "error": (
                "Email notifications disabled (NOTIFY_ON_RUN_COMPLETE=false) or "
                "missing RESEND_API_KEY / NOTIFY_EMAIL"
            ),
        }
    try:
        subject = f"[TEST] {service_label} — Resend check (NPSA)"
        text = (
            "This is an automated test message from the NPSA scraper email notifier.\n\n"
            "No state scrape was run — this is only a configuration check.\n\n"
            "If this arrived, your RESEND_API_KEY and NOTIFY_EMAIL settings are working.\n"
        )
        _send_resend_html(subject, _text_to_html(text))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def send_run_complete_email(
    run_id: str,
    state: str,
    counties_processed: int,
    total_counties: int,
    total_contacts: int = 0,
    total_with_emails: int = 0,
    duration_seconds: Optional[float] = None,
    csv_path: Optional[str] = None,
) -> None:
    """
    Send a single run-completion notification, with the finished CSV attached
    when one is available and small enough. No-op if not configured or if the
    send fails — a scrape that worked must not be reported as failed because
    the mail didn't go.

    Call only when transitioning a run to "completed"; claim the send at the
    call site so two replicas can't both deliver it.
    """
    if not _is_enabled():
        from school_run_log import log_warn
        log_warn(f"Notify disabled for {state}")
        return
    try:
        lines = [
            f"Run completed: {state}",
            f"Run ID: {run_id}",
            f"Counties: {counties_processed}/{total_counties}",
            f"Total contacts: {total_contacts}",
            f"Contacts with emails: {total_with_emails}",
        ]
        if duration_seconds is not None and duration_seconds >= 0:
            mins = int(duration_seconds // 60)
            secs = int(duration_seconds % 60)
            lines.append(f"Duration: {mins}m {secs}s")

        attachment, skipped_because = _read_attachment(csv_path)
        if attachment:
            lines.append("")
            lines.append(f"Attached: {attachment['filename']}")
        elif skipped_because:
            lines.append("")
            lines.append(f"The CSV is not attached because {skipped_because}.")
            lines.append("Download it from the Scraper tab in NPSA Tools.")
        elif total_contacts:
            # Contacts were found but no file reached us — worth saying plainly
            # rather than leaving someone waiting for an attachment.
            lines.append("")
            lines.append("The CSV wasn't available to attach. Download it from the Scraper tab.")

        body_text = "\n".join(lines)
        subject = f"[{SCRAPER_SUBJECT_TAG}] Run complete: {state}"
        _send_resend_html(subject, _text_to_html(body_text), attachment)
        from school_run_log import log_warn
        log_warn(f"Email sent: {state} ({run_id})")
    except Exception as e:
        from school_run_log import log_err
        log_err(f"Email failed: {state}: {e}")
