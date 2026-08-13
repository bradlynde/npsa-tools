"""
Auth Service - Centralized authentication for NPSA tools.

Login is passwordless: POST an email to /auth/request-code, receive a six-digit
code, POST it back to /auth/verify-code, get a JWT. The token is identical in
shape to the one the old password login issued, so every backend that verifies
it — the toolbox proxy, the scrapers, the LOE app — is unaffected.

There is no password route. There is no way to sign in without receiving mail
at an address in the users table, which is the point.
"""

import logging
import os
import time
from datetime import datetime, timedelta

import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

from database import (
    codes_sent_recently,
    create_login_code,
    get_user_by_email,
    init_db,
    purge_expired_codes,
    verify_login_code,
)
from mailer import send_login_code

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("auth")

# Config
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise ValueError("JWT_SECRET environment variable must be set")
JWT_ALGORITHM = "HS256"

# Matches the frontend's seven-day inactivity window. These used to disagree —
# the token died after 24h while the UI still believed it was signed in, so the
# dashboard's data calls started failing against a screen that looked fine.
JWT_EXPIRATION_HOURS = int(os.getenv("JWT_EXPIRATION_HOURS", "168"))

# Throttles. Per-address limits live in Postgres so they survive a restart and
# hold across replicas; the per-IP limit is in-process and best-effort, there to
# blunt a scripted sweep rather than to be authoritative.
RESEND_COOLDOWN_SECONDS = 60
MAX_CODES_PER_HOUR = 5
IP_MAX_REQUESTS = 20
IP_WINDOW_SECONDS = 600

app = FastAPI(title="NPSA Auth Service")

# CORS - allow frontend. Set CORS_ORIGINS in Railway (comma-separated, e.g. https://yourapp.vercel.app)
_cors = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_ip_hits: dict[str, list[float]] = {}


def _ip_allowed(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _ip_hits.get(ip, []) if now - t < IP_WINDOW_SECONDS]
    _ip_hits[ip] = hits
    if len(hits) >= IP_MAX_REQUESTS:
        return False
    hits.append(now)
    return True


def _issue_token(username: str) -> str:
    payload = {
        "username": username,
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


class LoginResponse(BaseModel):
    status: str
    token: str
    username: str


class RequestCodeRequest(BaseModel):
    email: EmailStr


class RequestCodeResponse(BaseModel):
    status: str


class VerifyCodeRequest(BaseModel):
    email: EmailStr
    code: str


@app.on_event("startup")
async def startup():
    init_db()
    try:
        purge_expired_codes()
    except Exception as exc:  # housekeeping must never block boot
        log.warning("Could not purge expired codes: %s", exc)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "auth"}


@app.post("/auth/request-code", response_model=RequestCodeResponse)
async def request_code(req: RequestCodeRequest, request: Request):
    """Email a sign-in code.

    Always answers the same way. Whether an address belongs to someone here is
    not something an unauthenticated caller gets to learn, so an unknown
    address, a throttled one, and a successful send are indistinguishable from
    the outside — the differences are in the log, not the response.
    """
    ip = request.client.host if request.client else "unknown"
    if not _ip_allowed(ip):
        log.warning("IP %s over the request-code limit", ip)
        return RequestCodeResponse(status="ok")

    email = req.email.lower().strip()
    user = get_user_by_email(email)
    if not user:
        log.info("request-code for unknown address %s", email)
        return RequestCodeResponse(status="ok")

    if codes_sent_recently(email, RESEND_COOLDOWN_SECONDS) > 0:
        log.info("request-code within cooldown for %s", email)
        return RequestCodeResponse(status="ok")
    if codes_sent_recently(email, 3600) >= MAX_CODES_PER_HOUR:
        log.warning("request-code hourly cap reached for %s", email)
        return RequestCodeResponse(status="ok")

    code = create_login_code(email)
    if not send_login_code(email, code):
        # Already logged with the reason. The caller still gets "ok" — telling
        # them delivery failed would leak that the address is real.
        log.error("Could not deliver a code to %s", email)

    return RequestCodeResponse(status="ok")


@app.post("/auth/verify-code", response_model=LoginResponse)
async def verify_code(req: VerifyCodeRequest, request: Request):
    ip = request.client.host if request.client else "unknown"
    if not _ip_allowed(ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again shortly.")

    email = req.email.lower().strip()
    user = get_user_by_email(email)

    # Verify even when the address is unknown? No — there is nothing to verify
    # against. But the failure must read the same as a wrong code.
    if not user or not verify_login_code(email, req.code):
        raise HTTPException(status_code=401, detail="That code isn't valid. Request a new one.")

    log.info("Signed in %s (%s)", user["username"], email)
    return LoginResponse(status="success", token=_issue_token(user["username"]), username=user["username"])
