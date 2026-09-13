"""POST /api/gxe -- genotype x environment reaction-norm study as a background job.

``run_gxe_analysis`` supports ``callback(GxECell)`` (one call per finished
(genotype, environment) cell), reused verbatim for progress. Like
sensitivity/active-learning, it does **not** support cooperative
cancellation: no ``should_stop`` hook exists on
``telomere_lab.analysis.gxe.run_gxe_analysis`` -- adding one would mean
threading a stop predicate through its nested genotype x environment loop,
out of scope for this phase. ``GxEConfig.validate()`` caps the grid at
``GXE_MAX_CELLS`` cells, so a runaway job is bounded even without
cancellation, but a job that is started still runs to completion once queued.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_gxe
from telomere_lab.schemas import ConfigError, GxEConfig, ModelConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(tags=["gxe"])


@router.post("/gxe", response_model=api_schemas.JobStartResponse)
def start_gxe(body: api_schemas.GxERequest, user: _db.User = Depends(get_current_user)
              ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model.to_plain()).validate()
        gxe_config = GxEConfig.from_dict(body.gxe).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    job = job_store.create_job(kind="gxe", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        def _on_progress(cell) -> None:
            job_store.set_progress(job, cell.to_dict())

        result, record = run_gxe(
            base_config, gxe_config,
            registry=ExperimentRegistry(),
            callback=_on_progress,
            notes=body.notes,
        )
        if record is not None:
            _db.record_user_run(user.id, record["run_id"])
        return {
            "run_id": record["run_id"] if record else None,
            "items": [it.to_dict() for it in result.items],
            "reranking_pairs": [list(p) for p in result.reranking_pairs],
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
