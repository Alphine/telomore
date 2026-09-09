"""POST /api/simulate -- a single, synchronous simulation run.

Fast enough (sub-second per ``tests/test_simulator.py::test_runtime_target_default_config``)
to be a plain request/response, unlike evolve/pareto/sensitivity/active-learning/benchmark
which go through the job-polling pattern in ``backend/jobs.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.runner import record_simulation, score
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.schemas import ConfigError, FitnessWeights, ModelConfig
from telomere_lab.experiments.runner import run_simulation as _run_simulation

from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(tags=["simulate"])


@router.post("/simulate", response_model=api_schemas.SimulateResponse)
def simulate(body: api_schemas.SimulateRequest, user: _db.User = Depends(get_current_user)
             ) -> api_schemas.SimulateResponse:
    try:
        config = ModelConfig.from_dict(body.config).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    result = _run_simulation(config)
    breakdown = score(result)
    record = record_simulation(result, registry=ExperimentRegistry(), notes="via API")
    _db.record_user_run(user.id, record["run_id"])

    payload = result.to_json_dict()
    payload["run_id"] = record["run_id"]
    payload["fitness"] = breakdown.to_dict()
    return api_schemas.SimulateResponse(run=payload)
