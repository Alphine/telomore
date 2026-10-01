"""Privacy-preserving usage logging (see docs/ADMIN.md).

A pure-ASGI middleware (no body reads, no ``BaseHTTPMiddleware`` buffering)
records one ``UsageEvent`` per ``/api/*`` request: route template, method,
status, duration, request size from ``Content-Length``, a salted+truncated
SHA-256 of the client IP and the user id decoded from the bearer token. Rows
go through a small bounded queue drained by one daemon writer thread, so the
request path never waits for the database and a DB failure is swallowed.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import logging
import os
import queue
import threading
import time
from typing import Any, Dict, List, Optional

from sqlalchemy import delete

from telomere_lab import db as _db

logger = logging.getLogger(__name__)

NO_STORE_PREFIXES = ("/api/admin", "/api/auth/me", "/api/access-requests")
_SKIP_PREFIXES = ("/api/admin",)
_SKIP_PATHS = ("/api/health",)

_COMPUTE = {
    "/api/simulate", "/api/simulate/ensemble", "/api/evolve", "/api/pareto", "/api/sensitivity",
    "/api/gxe", "/api/active-learning", "/api/benchmark", "/api/compare",
}


def iso(value: Optional[_dt.datetime]) -> Optional[str]:
    """Naive-UTC (or aware) datetime -> ``...Z`` ISO string."""
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="seconds") + "Z"


def enabled() -> bool:
    return os.environ.get("TELOMERE_USAGE_LOG", "on").strip().lower() not in ("off", "0", "false", "no")


def classify(endpoint: str) -> str:
    if endpoint in _COMPUTE:
        return "compute"
    if endpoint.startswith("/api/llm/") and endpoint != "/api/llm/validate-key":
        return "llm"
    if endpoint.startswith("/api/jobs"):
        return "job"
    if endpoint.startswith("/api/auth/"):
        return "auth"
    if endpoint.startswith("/api/access-requests"):
        return "access"
    if endpoint.startswith("/api/foci/"):
        return "foci"
    return "other"


COMPUTE_KINDS = ("compute", "llm")


def _salt() -> bytes:
    salt = os.environ.get("TELOMERE_IP_SALT") or os.environ.get("SECRET_KEY")
    if not salt:
        from . import auth  # ephemeral per-process key is fine as a salt
        salt = auth._SECRET_KEY
    return ("ip-hash:" + salt).encode("utf-8")


def hash_ip(ip: str) -> str:
    return hashlib.sha256(_salt() + ip.encode("utf-8")).hexdigest()[:16]


# ----------------------------------------------------------------- writer
_Q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=10000)
_thread: Optional[threading.Thread] = None
_thread_lock = threading.Lock()


def _writer() -> None:
    while True:
        batch = [_Q.get()]
        try:
            while len(batch) < 200:
                batch.append(_Q.get_nowait())
        except queue.Empty:
            pass
        try:
            session = _db.get_session()
            try:
                session.add_all([_db.UsageEvent(**row) for row in batch])
                session.commit()
            finally:
                session.close()
        except Exception:  # noqa: BLE001 - logging must never hurt the app
            logger.warning("usage event write failed (%d rows dropped)", len(batch), exc_info=True)
        finally:
            for _ in batch:
                _Q.task_done()


def _ensure_thread() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    with _thread_lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_writer, daemon=True, name="usage-writer")
            _thread.start()


def record(row: Dict[str, Any]) -> None:
    try:
        _ensure_thread()
        _Q.put_nowait(row)
    except queue.Full:
        logger.warning("usage queue full, event dropped")
    except Exception:  # noqa: BLE001
        logger.warning("usage enqueue failed", exc_info=True)


def flush(timeout: float = 10.0) -> None:
    """Wait until queued events are written (tests / shutdown)."""
    deadline = time.monotonic() + timeout
    while _Q.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.01)


def retention_days() -> int:
    try:
        return int(os.environ.get("TELOMERE_USAGE_RETENTION_DAYS", "90"))
    except ValueError:
        return 90


def prune() -> int:
    """Delete events older than the retention window. Returns rows removed."""
    days = retention_days()
    if days <= 0:
        return 0
    cutoff = _db.utcnow() - _dt.timedelta(days=days)
    session = _db.get_session()
    try:
        res = session.execute(delete(_db.UsageEvent).where(_db.UsageEvent.ts < cutoff))
        session.commit()
        return res.rowcount or 0
    finally:
        session.close()


def startup() -> None:
    """Lifespan hook: admin bootstrap + retention prune (never raises)."""
    try:
        n = _db.apply_admin_bootstrap()
        if n:
            logger.info("admin bootstrap updated %d account(s)", n)
    except Exception:  # noqa: BLE001
        logger.warning("admin bootstrap failed", exc_info=True)
    try:
        prune()
    except Exception:  # noqa: BLE001
        logger.warning("usage prune failed", exc_info=True)


# -------------------------------------------------------------- middleware
def _client_ip(scope) -> str:
    from .ratelimit import client_ip
    from starlette.requests import Request

    return client_ip(Request(scope))


def _user_id_from_headers(headers: List) -> Optional[int]:
    for k, v in headers:
        if k == b"authorization":
            parts = v.decode("latin-1").split(None, 1)
            if len(parts) == 2 and parts[0].lower() == "bearer":
                try:
                    from .auth import decode_access_token

                    return int(decode_access_token(parts[1].strip())["sub"])
                except Exception:  # noqa: BLE001 - invalid token is simply anonymous
                    return None
    return None


def _content_length(headers: List) -> Optional[int]:
    for k, v in headers:
        if k == b"content-length":
            try:
                return int(v)
            except ValueError:
                return None
    return None


class UsageMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        no_store = path.startswith(NO_STORE_PREFIXES)
        log = (
            enabled()
            and path.startswith("/api/")
            and not path.startswith(_SKIP_PREFIXES)
            and path not in _SKIP_PATHS
            and scope.get("method") != "OPTIONS"
        )
        if not log and not no_store:
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        status_holder = {"code": 500}

        async def send_wrapper(message) -> None:
            if message["type"] == "http.response.start":
                status_holder["code"] = message["status"]
                if no_store:
                    headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                    headers.append((b"cache-control", b"no-store"))
                    message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if log:
                try:
                    route = scope.get("route")
                    endpoint = getattr(route, "path", None) or "(unmatched)"
                    headers = scope.get("headers", [])
                    record({
                        "ts": _db.utcnow(),
                        "user_id": _user_id_from_headers(headers),
                        "endpoint": endpoint[:200],
                        "method": str(scope.get("method", ""))[:10],
                        "status_code": status_holder["code"],
                        "duration_ms": round((time.perf_counter() - started) * 1000.0, 2),
                        "ip_hash": hash_ip(_client_ip(scope)),
                        "req_bytes": _content_length(headers),
                        "kind": classify(endpoint),
                    })
                except Exception:  # noqa: BLE001
                    logger.warning("usage logging failed", exc_info=True)
