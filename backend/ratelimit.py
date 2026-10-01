"""Tiny dependency-free in-memory sliding-window rate limiter.

Per client IP, per named bucket. The client IP is the first hop of
``X-Forwarded-For`` when present (Railway and most PaaS sit behind a proxy
that sets it), else the socket peer. CAVEAT: that header is client-controlled;
if the app is ever exposed directly (no trusted proxy in front), an attacker
can rotate it to dodge the limit -- set ``TELOMERE_TRUST_PROXY=0`` there to
use the socket address only, or ``TELOMERE_TRUSTED_HOPS=1`` (one trusted
proxy appending to the header) to read the right-most, unforgeable entry. State is per process (like the job store).

Env: ``TELOMERE_RATE_LIMIT=off`` disables all buckets (also switched off by
``TELOMERE_DISABLE_LIMITS=1``); per-bucket ``TELOMERE_RATE_LIMIT_<BUCKET>`` =
max requests per window (``<=0``/``off`` = unlimited);
``TELOMERE_RATE_LIMIT_WINDOW`` = window seconds (default 60).
"""

from __future__ import annotations

import math
import os
import threading
import time
from collections import defaultdict, deque
from typing import Callable, Deque, Dict, Tuple

from fastapi import HTTPException, Request

from . import limits

_LOCK = threading.Lock()
_HITS: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)
_MAX_KEYS = 10000


def reset() -> None:
    with _LOCK:
        _HITS.clear()


def client_ip(request: Request) -> str:
    if os.environ.get("TELOMERE_TRUST_PROXY", "1").strip().lower() not in ("0", "false", "no", "off"):
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            parts = [p.strip() for p in fwd.split(",") if p.strip()]
            if parts:
                # TELOMERE_TRUSTED_HOPS=N: number of trusted proxies that append to
                # X-Forwarded-For; the client is then the Nth entry from the right,
                # which a caller cannot forge. 0 (default) = legacy first entry.
                try:
                    hops = int(os.environ.get("TELOMERE_TRUSTED_HOPS", "0"))
                except ValueError:
                    hops = 0
                idx = -hops if 0 < hops <= len(parts) else 0
                return parts[idx][:64]
    return request.client.host if request.client else "unknown"


def _enabled() -> bool:
    if limits.disabled():
        return False
    return os.environ.get("TELOMERE_RATE_LIMIT", "on").strip().lower() not in ("off", "0", "false", "no")


def rate_limit(bucket: str, default: int) -> Callable[[Request], None]:
    """FastAPI dependency: at most N requests per window per client IP."""
    env = f"TELOMERE_RATE_LIMIT_{bucket.upper()}"

    def _dep(request: Request) -> None:
        if not _enabled():
            return
        limit = limits.get_limit(env, default)
        if limit is None:
            return
        window = limits.get_limit("TELOMERE_RATE_LIMIT_WINDOW", 60) or 60
        now = time.monotonic()
        key = (bucket, client_ip(request))
        with _LOCK:
            if len(_HITS) > _MAX_KEYS:
                for k in [k for k, q in _HITS.items() if not q or now - q[-1] > window]:
                    _HITS.pop(k, None)
            q = _HITS[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, math.ceil(window - (now - q[0])))
                raise HTTPException(
                    429, f"Too many requests. Try again in {retry} s.", headers={"Retry-After": str(retry)}
                )
            q.append(now)

    return _dep
