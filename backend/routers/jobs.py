"""GET /api/jobs (list), GET /api/jobs/{job_id} and POST /api/jobs/{job_id}/stop --
listing + polling + cooperative cancellation for the background jobs started
by evolve/pareto/sensitivity/gxe/active-learning/benchmark. All routes are
owner-only: a user can only see or stop their own jobs (403 otherwise).

``GET /api/jobs`` exists so the frontend has a server-side source of truth
for "what's currently running" that survives page navigation -- a job page's
own ``jobId`` is plain component state, lost the moment the user navigates
away, even though the job itself keeps running server-side unaffected
(see ``jobs.py::run_job``'s detached daemon thread). See docs/API.md."""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=List[api_schemas.JobStatusResponse])
def list_active_jobs(user: _db.User = Depends(get_current_user)) -> List[api_schemas.JobStatusResponse]:
    return [api_schemas.JobStatusResponse(**j.to_public_dict()) for j in job_store.list_jobs(user.id)]


def _get_owned_job(job_id: str, user: _db.User) -> job_store.Job:
    job = job_store.get_job(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such job.")
    if job.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This job belongs to another user.")
    return job


@router.get("/{job_id}", response_model=api_schemas.JobStatusResponse)
def get_job_status(job_id: str, user: _db.User = Depends(get_current_user)) -> api_schemas.JobStatusResponse:
    job = _get_owned_job(job_id, user)
    return api_schemas.JobStatusResponse(**job.to_public_dict())


@router.post("/{job_id}/stop", response_model=api_schemas.JobStatusResponse)
def stop_job(job_id: str, user: _db.User = Depends(get_current_user)) -> api_schemas.JobStatusResponse:
    job = _get_owned_job(job_id, user)
    job_store.request_stop(job)
    return api_schemas.JobStatusResponse(**job.to_public_dict())
