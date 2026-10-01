"""POST /api/pareto -- NSGA-II multi-objective optimization as a background job.

``NSGA2Engine.run`` already supports ``callback(MOGenerationRecord)`` and
``should_stop()`` (see ``tests/test_multiobjective.py::test_stop_callback``),
reused verbatim.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_pareto
from telomere_lab.schemas import ConfigError, ModelConfig, MultiObjectiveConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from .. import limits
from ..auth import require_pro

router = APIRouter(tags=["pareto"])


@router.post("/pareto", response_model=api_schemas.JobStartResponse)
def start_pareto(body: api_schemas.ParetoRequest, user: _db.User = Depends(require_pro)
                  ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model.to_plain()).validate()
        mo_config = MultiObjectiveConfig.from_dict(body.multiobjective.to_plain()).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    limits.check_pareto(base_config, mo_config)

    job = job_store.create_job(kind="pareto", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        def _on_progress(rec) -> None:
            job_store.set_progress(job, rec.to_dict())

        def _should_stop() -> bool:
            return job.stop_event.is_set()

        result, record = run_pareto(
            base_config, mo_config,
            registry=ExperimentRegistry(),
            callback=_on_progress,
            should_stop=_should_stop,
            notes=body.notes,
        )
        if record is not None:
            _db.record_user_run(user.id, record["run_id"])
        return {
            "run_id": record["run_id"] if record else None,
            "front": [c.to_dict() for c in result.front],
            "baseline": result.baseline.to_dict(),
            "history": [h.to_dict() for h in result.history],
            "reference_point": result.reference_point,
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
            "stopped_early": result.stopped_early,
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
