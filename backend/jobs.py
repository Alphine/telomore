"""In-process background-job store for long-running operations.

Evolve / Pareto / Sensitivity / Active-Learning / Benchmark can take from
several seconds to a couple of minutes, and the whole point of the React
migration is live progress feedback during that time -- so these run in a
background ``threading.Thread`` (daemon=True) rather than as a synchronous
request/response like ``/api/simulate``.

Design (single paragraph, see also docs/API.md): a module-level dict
(``_JOBS``) keyed by a UUID4 job id holds a ``Job`` record with its status
(``pending`` -> ``running`` -> one of ``completed``/``failed``/``stopped``),
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
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

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


def create_job(kind: str, owner_id: int) -> Job:
    job = Job(job_id=str(uuid.uuid4()), kind=kind, owner_id=owner_id)
    with _LOCK:
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

    def _runner() -> None:
        with _LOCK:
            job.status = STATUS_RUNNING
            _touch(job)
        try:
            result = target(job)
        except Exception as exc:  # noqa: BLE001 - job failures must not vanish
            logger.exception("job %s (%s) failed", job.job_id, job.kind)
            with _LOCK:
                job.status = STATUS_FAILED
                job.error = str(exc)
                _touch(job)
            return
        with _LOCK:
            if job.stop_event.is_set() and job.status != STATUS_COMPLETED:
                job.status = STATUS_STOPPED
            else:
                job.status = STATUS_COMPLETED
            job.result = result
            _touch(job)

    thread = threading.Thread(target=_runner, daemon=True, name=f"job-{job.job_id[:8]}")
    thread.start()
