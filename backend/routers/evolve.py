"""POST /api/evolve -- genetic-algorithm optimization as a background job.

``EvolutionEngine.run`` already supports ``callback(GenerationRecord)`` and
``should_stop()`` (see ``tests/test_evolution.py::test_stop_callback_and_progress_callback``)
so this is a thin wiring layer, not a new progress mechanism.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_evolution
from telomere_lab.schemas import ConfigError, EvolutionConfig, ModelConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(tags=["evolve"])


@router.post("/evolve", response_model=api_schemas.JobStartResponse)
def start_evolve(body: api_schemas.EvolveRequest, user: _db.User = Depends(get_current_user)
                  ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model).validate()
        evo_config = EvolutionConfig.from_dict(body.evolution).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    job = job_store.create_job(kind="evolve", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        def _on_progress(rec) -> None:
            job_store.set_progress(job, rec.to_dict())

        def _should_stop() -> bool:
            return job.stop_event.is_set()

        result, record = run_evolution(
            base_config, evo_config,
            registry=ExperimentRegistry(),
            callback=_on_progress,
            should_stop=_should_stop,
            notes=body.notes,
        )
        if record is not None:
            _db.record_user_run(user.id, record["run_id"])
        return {
            "run_id": record["run_id"] if record else None,
            "best": result.best.to_dict(),
            "baseline": result.baseline.to_dict(),
            "history": [h.to_dict() for h in result.history],
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
            "stopped_early": result.stopped_early,
            "stop_reason": result.stop_reason,
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
