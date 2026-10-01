"""JWT issuance/verification and the ``get_current_user`` FastAPI dependency.

Mirrors the env-var-with-dev-fallback pattern already used twice in this
codebase (``DATABASE_URL`` in ``telomere_lab/db.py``, ``RESEND_API_KEY`` in
``telomere_lab/email.py``): if ``SECRET_KEY`` is not set in the environment,
a random per-process secret is generated with a loud warning logged. This is
fine for local dev/CI (and even for a first Railway deploy that hasn't set
the env var yet), but it means every existing JWT is invalidated whenever
the process restarts -- so ``SECRET_KEY`` MUST be set as a real Railway env
var once this API is actually deployed (see docs/API.md).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import logging
import os
import secrets

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from telomere_lab import db as _db

logger = logging.getLogger(__name__)

JWT_ALGORITHM = "HS256"
JWT_EXPIRES_IN = _dt.timedelta(days=7)

_SECRET_KEY = os.environ.get("SECRET_KEY")
if not _SECRET_KEY and os.environ.get("RAILWAY_ENVIRONMENT"):
    # A per-process random key would silently log everyone out on every
    # restart/redeploy and break multi-replica setups: refuse to start.
    raise RuntimeError("SECRET_KEY must be set when running on Railway (RAILWAY_ENVIRONMENT is set).")
if not _SECRET_KEY:
    _SECRET_KEY = secrets.token_urlsafe(48)
    logger.warning(
        "SECRET_KEY not set -- using an ephemeral dev secret, tokens will be "
        "invalidated on restart. Set SECRET_KEY as a real env var before "
        "deploying this API."
    )

_bearer_scheme = HTTPBearer(auto_error=False)


def _pw_fingerprint(user: _db.User) -> str:
    """Short digest of the password hash: changing the password (e.g. via the
    reset flow) invalidates every token issued before it."""
    return hashlib.sha256(("pwv:" + (user.password_hash or "")).encode("utf-8")).hexdigest()[:12]


def create_access_token(user: _db.User) -> str:
    now = _dt.datetime.now(_dt.timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "pwv": _pw_fingerprint(user),
        "iat": now,
        "exp": now + JWT_EXPIRES_IN,
    }
    return jwt.encode(payload, _SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Raise ``jwt.PyJWTError`` on any invalid/expired token."""
    return jwt.decode(token, _SECRET_KEY, algorithms=[JWT_ALGORITHM])


_CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)

_UNVERIFIED_ERROR = HTTPException(
    status_code=status.HTTP_403_FORBIDDEN,
    detail="Email not verified. Check your inbox for a verification link.",
)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> _db.User:
    """FastAPI dependency: extract + verify the bearer JWT, load the user,
    and gate on ``is_verified`` -- the single auth gate every protected
    route in this API uses (mirrors ``require_login()`` in the Streamlit
    app, which gates on both logged-in AND verified)."""
    if credentials is None:
        raise _CREDENTIALS_ERROR
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        raise _CREDENTIALS_ERROR

    session = _db.get_session()
    try:
        user = session.get(_db.User, user_id)
    finally:
        session.close()

    if user is None:
        raise _CREDENTIALS_ERROR
    pwv = payload.get("pwv")  # absent on tokens minted before this claim existed (<= 7 days old)
    if pwv is not None and not hmac.compare_digest(str(pwv), _pw_fingerprint(user)):
        raise _CREDENTIALS_ERROR
    if user.is_disabled:
        raise account_disabled_error()
    if not user.is_verified:
        raise _UNVERIFIED_ERROR
    if user.last_seen_at is None or _db.utcnow() - user.last_seen_at > _dt.timedelta(minutes=5):
        _db.touch_last_seen(user.id)
    return user


def error_detail(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def account_disabled_error() -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN,
                         detail=error_detail("account_disabled", "This account has been disabled."))


def pro_required() -> bool:
    return os.environ.get("TELOMERE_REQUIRE_PRO", "1").strip().lower() not in ("0", "false", "no", "off")


def require_pro(user: _db.User = Depends(get_current_user)) -> _db.User:
    """Compute gate: verified, enabled and on an unexpired PRO plan (or admin)."""
    if pro_required() and _db.effective_plan(user) != _db.PLAN_PRO:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail=error_detail("pro_required",
                                "Running computations needs a PRO account. Request access from your account page."),
        )
    return user


def require_admin(user: _db.User = Depends(get_current_user)) -> _db.User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail=error_detail("admin_required", "Administrator access required."))
    return user
