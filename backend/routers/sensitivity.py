"""POST /api/sensitivity -- one-at-a-time sensitivity analysis as a background job.

``run_sensitivity_analysis`` supports ``callback(ParameterSensitivity)`` (one
call per parameter finished), reused verbatim for progress. It does **not**
support cooperative cancellation (no ``should_stop`` parameter exists on
``telomere_lab.analysis.sensitivity.run_sensitivity_analysis``) -- adding one
would mean threading a stop predicate through its per-parameter perturbation
loop, which is out of scope for this phase since OAT sweeps are short (one
sim pair per parameter) and finish quickly. ``POST /api/jobs/{id}/stop``
still records the stop request, but it will not interrupt an in-flight
sensitivity run early; it only prevents the *next* parameter from starting
if the loop happens to check between parameters (it doesn't, currently), so
in practice a sensitivity job runs to completion once started. Documented as
a scoped-down limitation for Phase 1.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_sensitivity
from telomere_lab.schemas import ConfigError, ModelConfig, SensitivityConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from .. import limits
from ..auth import require_pro

router = APIRouter(tags=["sensitivity"])


@router.post("/sensitivity", response_model=api_schemas.JobStartResponse)
def start_sensitivity(body: api_schemas.SensitivityRequest, user: _db.User = Depends(require_pro)
                       ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model.to_plain()).validate()
        sens_config = SensitivityConfig.from_dict(body.sensitivity).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    limits.check_sensitivity(base_config, sens_config)

    job = job_store.create_job(kind="sensitivity", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        def _on_progress(item) -> None:
            job_store.set_progress(job, item.to_dict())

        result, record = run_sensitivity(
            base_config, sens_config,
            registry=ExperimentRegistry(),
            callback=_on_progress,
            notes=body.notes,
        )
        if record is not None:
            _db.record_user_run(user.id, record["run_id"])
        return {
            "run_id": record["run_id"] if record else None,
            "baseline_fitness": result.baseline_fitness,
            "items": [it.to_dict() for it in result.items],
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
