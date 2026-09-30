"""In-process background-job store for long-running operations.

Evolve / Pareto / Sensitivity / Active-Learning / Benchmark can take from
several seconds to a couple of minutes, and the whole point of the React
migration is live progress feedback during that time -- so these run in a
background ``threading.Thread`` (daemon=True) rather than as a synchronous
request/response like ``/api/simulate``.

Design (single paragraph, see also docs/API.md): a module-level dict
(``_JOBS``) keyed by a UUID4 job id holds a ``Job`` record with its status
(``pending`` [queued until a run slot is free] -> ``running`` -> one of ``completed``/``failed``/``stopped``),
whatever progress payload the underlying engine's own ``progress_callback``
already produces (reused verbatim -- ``GenerationRecord.to_dict()``,
``MOGenerationRecord.to_dict()``, etc. -- no new progress shape is invented),
the final JSON-able result once done, and a ``threading.Event`` used as the
stop flag for engines that support cooperative cancellation
(``should_stop``). A background thread is used instead of FastAPI's
``BackgroundTasks`` because the client needs the job id back *immediately*
(before the response is sent) so it can start polling
``GET /api/jobs/{id}`` right away. This is a single-process, in-memory store
-- fine for this project's current scale (one Railway service, no
horizontal scaling), but it is a known limitation: jobs do not survive a
process restart and are invisible to any second worker process. A future
phase could swap this for Redis/RQ/Celery without changing the router
contract if that scaling need ever materializes.
"""

from __future__ import annotations

import datetime as _dt
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException

from . import limits

logger = logging.getLogger(__name__)

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_STOPPED = "stopped"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


@dataclass
class Job:
    job_id: str
    kind: str
    owner_id: int
    status: str = STATUS_PENDING
    progress: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    stop_event: threading.Event = field(default_factory=threading.Event)
    finished_at: Optional[float] = None  # time.time() when a terminal status was set (eviction clock)

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


_JOBS: Dict[str, Job] = {}
_LOCK = threading.Lock()
_TERMINAL = (STATUS_COMPLETED, STATUS_FAILED, STATUS_STOPPED)

# Concurrency: at most MAX_CONCURRENT jobs execute at once; further jobs stay
# ``pending`` (the existing status the frontend already treats as "not
# finished") until a slot frees up. Env vars are read lazily; see
# docs/API.md "Limits and security notes".
_SLOT_LOCK = threading.Condition()
_RUNNING_COUNT = 0


def _max_concurrent() -> Optional[int]:
    v = limits.get_limit("TELOMERE_MAX_CONCURRENT_JOBS", 2)
    return None if v is None else max(1, int(v))


def _acquire_slot(job: Job) -> bool:
    """Block (job stays ``pending``) until a run slot is free. Returns False
    if the job was stopped while still queued."""
    global _RUNNING_COUNT
    with _SLOT_LOCK:
        while True:
            if job.stop_event.is_set():
                return False
            cap = _max_concurrent()
            if cap is None or _RUNNING_COUNT < cap:
                _RUNNING_COUNT += 1
                return True
            _SLOT_LOCK.wait(timeout=0.25)


def _release_slot() -> None:
    global _RUNNING_COUNT
    with _SLOT_LOCK:
        _RUNNING_COUNT = max(0, _RUNNING_COUNT - 1)
        _SLOT_LOCK.notify_all()


def _evict_locked(now: Optional[float] = None) -> None:
    """Drop finished jobs older than the TTL, then the oldest finished ones
    beyond the size cap. Caller holds ``_LOCK``."""
    now = time.time() if now is None else now
    ttl = limits.get_limit("TELOMERE_JOB_TTL_SECONDS", 3600)
    finished = [j for j in _JOBS.values() if j.status in _TERMINAL]
    if ttl is not None:
        for j in finished:
            if j.finished_at is not None and now - j.finished_at > ttl:
                _JOBS.pop(j.job_id, None)
        finished = [j for j in finished if j.job_id in _JOBS]
    cap = limits.get_limit("TELOMERE_MAX_FINISHED_JOBS", 200)
    if cap is not None and len(finished) > cap:
        finished.sort(key=lambda j: j.finished_at or 0.0)
        for j in finished[: len(finished) - int(cap)]:
            _JOBS.pop(j.job_id, None)


def create_job(kind: str, owner_id: int) -> Job:
    """Register a new pending job, or raise 429 when the caller already has
    too many active jobs / the server queue is full."""
    with _LOCK:
        _evict_locked()
        active = [j for j in _JOBS.values() if j.status not in _TERMINAL]
        per_user = limits.get_limit("TELOMERE_MAX_ACTIVE_JOBS_PER_USER", 3)
        if per_user is not None and sum(1 for j in active if j.owner_id == owner_id) >= per_user:
            raise HTTPException(
                429,
                f"You already have {int(per_user)} active jobs (running or queued). Wait for one to finish "
                "or stop it before starting another (env var TELOMERE_MAX_ACTIVE_JOBS_PER_USER).",
                headers={"Retry-After": "30"},
            )
        queue_cap = limits.get_limit("TELOMERE_MAX_QUEUED_JOBS", 50)
        if queue_cap is not None and len(active) >= queue_cap:
            raise HTTPException(
                429,
                "The job queue is full. Try again in a few minutes (env var TELOMERE_MAX_QUEUED_JOBS).",
                headers={"Retry-After": "60"},
            )
        job = Job(job_id=str(uuid.uuid4()), kind=kind, owner_id=owner_id)
        _JOBS[job.job_id] = job
    return job


def get_job(job_id: str) -> Optional[Job]:
    with _LOCK:
        return _JOBS.get(job_id)


def list_jobs(owner_id: int) -> List[Job]:
    """Active (not yet terminal) jobs owned by ``owner_id``, newest first.

    Used by ``GET /api/jobs`` to power a persistent "jobs in progress"
    indicator that survives page navigation (unlike a page's own local
    ``jobId`` state, which is lost on unmount) -- see docs/API.md.
    """
    with _LOCK:
        jobs = [j for j in _JOBS.values() if j.owner_id == owner_id and j.status in (STATUS_PENDING, STATUS_RUNNING)]
    jobs.sort(key=lambda j: j.created_at, reverse=True)
    return jobs


def _touch(job: Job) -> None:
    job.updated_at = _now()


def set_progress(job: Job, payload: Dict[str, Any]) -> None:
    with _LOCK:
        job.progress = payload
        job.status = STATUS_RUNNING
        _touch(job)


def request_stop(job: Job) -> None:
    job.stop_event.set()


def run_job(job: Job, target: Callable[[Job], Dict[str, Any]]) -> None:
    """Run ``target(job)`` on a daemon thread. ``target`` must return the
    JSON-able result dict on success, and may call ``job.stop_event.is_set()``
    (via a ``should_stop`` callback wired to the underlying engine) to react
    to a stop request. Any exception raised by ``target`` is caught and
    recorded as a failed job rather than crashing the thread silently."""

    def _finish(status: str, *, result=None, error=None) -> None:
        with _LOCK:
            job.status = status
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error
            job.finished_at = time.time()
            _touch(job)

    def _runner() -> None:
        if not _acquire_slot(job):  # stopped while queued: never ran
            _finish(STATUS_STOPPED)
            return
        try:
            with _LOCK:
                job.status = STATUS_RUNNING
                _touch(job)
            try:
                result = target(job)
            except Exception as exc:  # noqa: BLE001 - job failures must not vanish
                logger.exception("job %s (%s) failed", job.job_id, job.kind)
                _finish(STATUS_FAILED, error=str(exc))
                return
            _finish(STATUS_STOPPED if job.stop_event.is_set() else STATUS_COMPLETED, result=result)
        finally:
            _release_slot()

    thread = threading.Thread(target=_runner, daemon=True, name=f"job-{job.job_id[:8]}")
    thread.start()
