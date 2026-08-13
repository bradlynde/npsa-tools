"""
Sending login codes, via Resend.

Deliberately a thin call rather than the Resend SDK: one POST, one dependency
we already have, and nothing to keep up to date.

If RESEND_API_KEY is unset the code is logged instead of sent. That keeps local
development working without a key — and it is why the log line is explicit
about what just happened, so nobody mistakes it for production behaviour.
"""

import logging
import os

import httpx

log = logging.getLogger("auth.mailer")

RESEND_API_KEY = os.getenv("RESEND_API_KEY")
MAIL_FROM = os.getenv("AUTH_EMAIL_FROM", "NPSA Tools <login@nonprofitsecurityadvisors.com>")
CODE_TTL_MINUTES = 10


def _text(code: str) -> str:
    return (
        f"Your NPSA Tools sign-in code is {code}\n\n"
        f"It expires in {CODE_TTL_MINUTES} minutes and can only be used once.\n\n"
        "If you didn't try to sign in, you can ignore this email — but tell "
        "Stuart, because it means someone else entered your address."
    )


def _html(code: str) -> str:
    # Inline styles and a table: email clients are not browsers.
    return f"""\
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fbfaf8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#fbfaf8;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:440px;background:#ffffff;border:1px solid #e7e2d6;
                      border-radius:14px;padding:32px;">
          <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
            <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;
                        color:#8a8577;font-weight:600;">NPSA Tools</div>
            <div style="font-size:22px;color:#182230;margin:10px 0 20px;">
              Your sign-in code
            </div>
            <div style="font-size:34px;font-weight:700;letter-spacing:.18em;
                        color:#1e3a5f;background:#f6f4ee;border:1px solid #e7e2d6;
                        border-radius:10px;padding:16px;text-align:center;">
              {code}
            </div>
            <div style="font-size:13px;color:#4a5462;line-height:1.6;margin-top:20px;">
              Expires in {CODE_TTL_MINUTES} minutes, and works once.
            </div>
            <div style="font-size:12px;color:#8a8577;line-height:1.6;margin-top:16px;">
              Didn't try to sign in? You can ignore this — but let Stuart know,
              because it means someone else entered your address.
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>"""


def send_login_code(email: str, code: str) -> bool:
    """Returns whether the code was handed to Resend.

    The caller must not vary its response based on this — a failure here is
    logged and swallowed at the route, so the endpoint stays uniform.
    """
    if not RESEND_API_KEY:
        log.warning("RESEND_API_KEY unset — NOT sending. Code for %s is %s", email, code)
        return False

    try:
        res = httpx.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "from": MAIL_FROM,
                "to": [email],
                "subject": f"{code} is your NPSA Tools sign-in code",
                "text": _text(code),
                "html": _html(code),
            },
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.error("Resend request failed for %s: %s", email, exc)
        return False

    if res.status_code >= 400:
        # Body, not just status: Resend explains unverified domains here.
        log.error("Resend rejected send to %s: %s %s", email, res.status_code, res.text)
        return False
    return True
