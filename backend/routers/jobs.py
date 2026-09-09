"""GET /api/jobs/{job_id} and POST /api/jobs/{job_id}/stop -- polling + cooperative
cancellation for the background jobs started by evolve/pareto/sensitivity/
active-learning/benchmark. Both routes are owner-only: a user can only see
or stop their own jobs (403 otherwise)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(prefix="/jobs", tags=["jobs"])


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
