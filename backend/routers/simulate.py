"""POST /api/simulate -- a single, synchronous simulation run.

Fast enough (sub-second per ``tests/test_simulator.py::test_runtime_target_default_config``)
to be a plain request/response, unlike evolve/pareto/sensitivity/active-learning/benchmark
which go through the job-polling pattern in ``backend/jobs.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.runner import (
    record_ensemble,
    record_simulation,
    run_ensemble as _run_ensemble,
    score,
    summarize_ensemble,
)
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
        config = ModelConfig.from_dict(body.config.to_plain()).validate()
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


@router.post("/simulate/ensemble", response_model=api_schemas.EnsembleResponse)
def simulate_ensemble(body: api_schemas.EnsembleRequest, user: _db.User = Depends(get_current_user)
                      ) -> api_schemas.EnsembleResponse:
    """Run ``simulate()`` unchanged once per seed and return the spread across
    seeds (ROADMAP.md candidate feature #2), instead of a single trajectory.

    Seeds used: ``base_seed, base_seed + 1, ..., base_seed + n_seeds - 1``
    (``base_seed`` defaults to the config's own ``seed``) -- an explicit,
    reproducible offset convention distinct from the free-form ``eval_seeds``
    tuples the GA/NSGA-II/active-learner take, since those are user-supplied
    lists rather than a range to be generated here.
    """
    if not (api_schemas.MIN_ENSEMBLE_SEEDS <= body.n_seeds <= api_schemas.MAX_ENSEMBLE_SEEDS):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"n_seeds={body.n_seeds} outside [{api_schemas.MIN_ENSEMBLE_SEEDS}, {api_schemas.MAX_ENSEMBLE_SEEDS}]",
        )
    try:
        config = ModelConfig.from_dict(body.config.to_plain()).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    base_seed = int(body.base_seed) if body.base_seed is not None else int(config.seed)
    seeds = [base_seed + i for i in range(body.n_seeds)]

    results = _run_ensemble(config, seeds)
    bands = summarize_ensemble(results)
    record = record_ensemble(config, results, seeds, registry=ExperimentRegistry(),
                             notes=f"ensemble of {body.n_seeds} seeds via API")
    _db.record_user_run(user.id, record["run_id"])

    applied_schedule = {}
    for r in results:
        if r.valid and r.applied_schedule:
            applied_schedule = {k: v.tolist() for k, v in r.applied_schedule.items()}
            break

    series = [
        api_schemas.EnsembleSeedResult(
            seed=r.seed,
            valid=r.valid,
            failure_reason=r.failure_reason,
            mean_length=r.mean_length.tolist(),
            shortest_length=r.shortest_length.tolist(),
            population_size=r.population_size.tolist(),
            proliferative_count=r.proliferative_count.tolist(),
            senescent_fraction=r.senescent_fraction.tolist(),
            terminal_metrics=r.terminal_metrics,
        )
        for r in results
    ]

    return api_schemas.EnsembleResponse(
        run_id=record["run_id"],
        n_seeds=body.n_seeds,
        base_seed=base_seed,
        seeds=seeds,
        config=config.to_dict(),
        config_hash=config.config_hash(),
        bands=api_schemas.EnsembleBands(**bands),
        series=series,
        applied_schedule=applied_schedule,
    )
