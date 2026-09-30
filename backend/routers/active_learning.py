"""POST /api/active-learning -- surrogate-model (GP + EI) active learning as a background job.

``SurrogateActiveLearner.run`` supports ``callback(ActiveLearningRecord)``
(one call per real-simulator evaluation), reused verbatim for progress. Like
sensitivity, it has no ``should_stop`` hook -- adding cooperative
cancellation to the GP-refit loop was judged too invasive for this phase (it
would touch the surrogate's fit/acquire/evaluate cycle in
``telomere_lab/evolution/surrogate.py``, which §"REUSE, don't restructure"
in the task brief explicitly warns against). ``POST /api/jobs/{id}/stop``
records the request but an active-learning job runs to completion once
started -- documented as a scoped-down limitation for Phase 1.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_active_learning
from telomere_lab.schemas import ActiveLearningConfig, ConfigError, ModelConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from .. import limits
from ..auth import get_current_user

router = APIRouter(tags=["active-learning"])


@router.post("/active-learning", response_model=api_schemas.JobStartResponse)
def start_active_learning(body: api_schemas.ActiveLearningRequest, user: _db.User = Depends(get_current_user)
                           ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model.to_plain()).validate()
        al_config = ActiveLearningConfig.from_dict(body.active_learning.to_plain()).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    limits.check_active_learning(base_config, al_config)

    job = job_store.create_job(kind="active_learning", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        def _on_progress(rec) -> None:
            job_store.set_progress(job, rec.to_dict())

        result, record = run_active_learning(
            base_config, al_config,
            registry=ExperimentRegistry(),
            callback=_on_progress,
            notes=body.notes,
        )
        if record is not None:
            _db.record_user_run(user.id, record["run_id"])
        return {
            "run_id": record["run_id"] if record else None,
            "best_genome": result.best_genome,
            "best_fitness": result.best_fitness,
            "records": [r.to_dict() for r in result.records],
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
