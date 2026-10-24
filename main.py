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
import threading
import time
from contextlib import asynccontextmanager

import jwt
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

from database import (
    MAX_FAILED_VERIFIES,
    VERIFY_LOCKED,
    VERIFY_OK,
    burn_check,
    codes_sent_recently,
    create_login_code,
    get_user_by_email,
    get_user_by_username,
    init_db,
    is_locked_out,
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

# How long a sign-in lasts without use. Each token is issued for this long, and
# the toolbox swaps it for a fresh one (POST /auth/refresh) about twice a day
# while someone is using it, so the window counts from their last use rather
# than from when they typed a code. Someone away longer than this signs in again.
JWT_EXPIRATION_HOURS = int(os.getenv("JWT_EXPIRATION_HOURS", str(14 * 24)))

# How long a sign-in can be kept alive by renewal at all. Every token carries
# `auth_time`, when its owner last entered an emailed code; once that is older
# than this, /auth/refresh refuses and they sign in again, however active.
# A value that is not a number, or under a day, falls back to the default
# rather than locking everyone out.
def _session_days() -> float:
    raw = os.getenv("AUTH_MAX_SESSION_DAYS", "30")
    try:
        days = float(raw)
    except ValueError:
        days = 0
    if not days >= 1:
        log.warning("AUTH_MAX_SESSION_DAYS=%r is not a number of days >= 1; using 30", raw)
        return 30.0
    return days


MAX_SESSION_SECONDS = int(_session_days() * 86400)

# Throttles. Per-address limits live in Postgres so they survive a restart and
# hold across replicas, and they are what protect an account. The per-IP limits
# are in-process and best-effort, there to blunt a scripted sweep. Callers such
# as the toolbox and the LOE app reach this service from their own servers, so
# many people share one IP here; these limits are set well above what that
# shared traffic needs, and requesting and verifying are counted separately.
RESEND_COOLDOWN_SECONDS = 60
MAX_CODES_PER_HOUR = 5
IP_WINDOW_SECONDS = 600
IP_MAX_CODE_REQUESTS = 60
IP_MAX_VERIFY_REQUESTS = 60


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    try:
        purge_expired_codes()
    except Exception as exc:  # housekeeping must never block boot
        log.warning("Could not purge expired codes: %s", exc)
    yield


app = FastAPI(title="NPSA Auth Service", lifespan=lifespan)

# CORS - allow frontend. Set CORS_ORIGINS in Railway (comma-separated, e.g. https://yourapp.vercel.app)
_cors = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_ip_hits: dict[tuple[str, str], list[float]] = {}
_ip_lock = threading.Lock()


def _ip_allowed(bucket: str, ip: str, limit: int) -> bool:
    now = time.time()
    with _ip_lock:
        key = (bucket, ip)
        hits = [t for t in _ip_hits.get(key, []) if now - t < IP_WINDOW_SECONDS]
        allowed = len(hits) < limit
        if allowed:
            hits.append(now)
        _ip_hits[key] = hits
        if len(_ip_hits) > 10_000:  # keep a sweep from growing this forever
            for k in [k for k, v in _ip_hits.items() if not v or now - v[-1] >= IP_WINDOW_SECONDS]:
                del _ip_hits[k]
        return allowed


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _issue_token(username: str, auth_time: int) -> str:
    now = int(time.time())
    payload = {
        "username": username,
        # Never past the end of the session, so renewal cannot outlast it.
        "exp": min(now + JWT_EXPIRATION_HOURS * 3600, auth_time + MAX_SESSION_SECONDS),
        "iat": now,
        "auth_time": auth_time,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _int_claim(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _locked_out_warning(email: str, where: str) -> None:
    # A stable prefix for log alerting. Seeing this means someone has entered a
    # lot of wrong codes for a real address.
    log.warning(
        "SECURITY-ALERT sign-in locked: %s has %d+ wrong codes in 24h (%s refused)",
        email, MAX_FAILED_VERIFIES, where,
    )


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


class RefreshRequest(BaseModel):
    token: str


@app.get("/health")
async def health():
    return {"status": "ok", "service": "auth"}


def _send_code_if_allowed(email: str) -> None:
    """Everything request-code does that depends on the address.

    Runs after the response has gone out, so how long it takes (a bcrypt hash
    and a call to Resend for a real address, almost nothing for an unknown one)
    is not visible to the caller.
    """
    try:
        user = get_user_by_email(email)
        if not user:
            log.info("request-code for unknown address %s", email)
            return
        if is_locked_out(email):
            _locked_out_warning(email, "request-code")
            return
        if codes_sent_recently(email, RESEND_COOLDOWN_SECONDS) > 0:
            log.info("request-code within cooldown for %s", email)
            return
        if codes_sent_recently(email, 3600) >= MAX_CODES_PER_HOUR:
            log.warning("request-code hourly cap reached for %s", email)
            return

        code = create_login_code(email)
        if not send_login_code(email, code):
            # Already logged with the reason.
            log.error("Could not deliver a code to %s", email)
    except Exception:
        log.exception("request-code failed for %s", email)


@app.post("/auth/request-code", response_model=RequestCodeResponse)
async def request_code(req: RequestCodeRequest, request: Request, background_tasks: BackgroundTasks):
    """Email a sign-in code.

    Always answers the same way, and in the same time. Whether an address
    belongs to someone here is not something an unauthenticated caller gets to
    learn, so an unknown address, a throttled one, and a successful send are
    indistinguishable from the outside — the differences are in the log, not
    the response. All of the per-address work happens after the response.
    """
    ip = _client_ip(request)
    if not _ip_allowed("request-code", ip, IP_MAX_CODE_REQUESTS):
        log.warning("IP %s over the request-code limit", ip)
        return RequestCodeResponse(status="ok")

    background_tasks.add_task(_send_code_if_allowed, req.email.lower().strip())
    return RequestCodeResponse(status="ok")


@app.post("/auth/verify-code", response_model=LoginResponse)
def verify_code(req: VerifyCodeRequest, request: Request):
    ip = _client_ip(request)
    if not _ip_allowed("verify-code", ip, IP_MAX_VERIFY_REQUESTS):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again shortly.")

    email = req.email.lower().strip()
    user = get_user_by_email(email)

    # Every failure — unknown address, wrong or used code, or an address that
    # has had too many wrong codes — reads the same, and costs the same.
    if not user:
        burn_check(req.code)
        outcome = None
    else:
        outcome = verify_login_code(email, req.code)
        if outcome == VERIFY_LOCKED:
            _locked_out_warning(email, "verify-code")
    if outcome != VERIFY_OK:
        raise HTTPException(status_code=401, detail="That code isn't valid. Request a new one.")

    log.info("Signed in %s (%s)", user["username"], email)
    token = _issue_token(user["username"], auth_time=int(time.time()))
    return LoginResponse(status="success", token=token, username=user["username"])


@app.post("/auth/refresh", response_model=LoginResponse)
def refresh(req: RefreshRequest):
    """Swap a sign-in token that still works for a fresh one.

    Only a token this service signed and that hasn't lapsed is accepted, and
    only for someone still in the users table, so removing a person ends their
    sign-in at its next renewal. A lapsed or unknown token gets 401: sign in again.

    The fresh token keeps the original `auth_time`, and once that is older than
    the maximum session age the answer is 401 too. Tokens issued before
    `auth_time` existed are accepted once and given one, taken from their `iat`.
    """
    expired = HTTPException(status_code=401, detail="This sign-in has expired. Sign in again.")
    try:
        claims = jwt.decode(
            req.token, JWT_SECRET, algorithms=[JWT_ALGORITHM], options={"require": ["exp"]}
        )
    except jwt.PyJWTError:
        raise expired
    user = get_user_by_username(str(claims.get("username") or ""))
    if not user:
        raise expired

    now = int(time.time())
    auth_time = _int_claim(claims.get("auth_time"))
    if auth_time is None:
        # Issued before auth_time existed. Start its session clock at its iat,
        # or now if that is missing or would already be past the limit; either
        # way this renewal succeeds.
        iat = _int_claim(claims.get("iat"))
        auth_time = iat if iat is not None and 0 <= now - iat < MAX_SESSION_SECONDS else now
        log.info("Refresh for %s: token had no auth_time, session clock started", user["username"])
    else:
        auth_time = min(auth_time, now)
        if now - auth_time >= MAX_SESSION_SECONDS:
            log.info("Refresh refused for %s: session older than the maximum age", user["username"])
            raise expired

    token = _issue_token(user["username"], auth_time=auth_time)
    return LoginResponse(status="success", token=token, username=user["username"])
