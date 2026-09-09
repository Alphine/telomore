"""POST /api/benchmark -- budget-matched GA vs NSGA-II vs random search vs active learning.

Scoped down from the other job endpoints, documented deliberately:

* ``telomere_lab.evolution.benchmark`` (``run_ga_benchmark``, ``run_nsga2_benchmark``,
  ``run_random_search``, ``run_active_learning_benchmark``) has no
  ``callback``/``should_stop`` parameters at all on any of its four
  functions, and it is not wired through ``experiments/runner.py`` (no
  ledger registration, no ``run_dir``). Adding progress/cancellation hooks
  or ledger wiring to it would mean restructuring that module, which the
  task brief says to avoid for anything under ``evolution/``. So this job
  runs all four methods sequentially with no live progress (the job's
  ``progress`` field stays ``null`` the whole time; poll ``GET
  /api/jobs/{id}`` and it will flip straight from ``running`` to
  ``completed``) and does **not** call ``db.record_user_run`` (there is no
  ledger ``run_id`` to record).
* ``POST /api/jobs/{id}/stop`` has no effect on a benchmark job for the same
  reason -- it runs to completion once started.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.evolution.benchmark import (
    active_learning_config_for_budget,
    budget_evaluations,
    combined_frame,
    run_active_learning_benchmark,
    run_ga_benchmark,
    run_nsga2_benchmark,
    run_random_search,
)
from telomere_lab.schemas import ConfigError, EvolutionConfig, ModelConfig, MultiObjectiveConfig

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(tags=["benchmark"])


def _result_to_dict(name: str, result) -> dict:
    return {
        "method": result.method,
        "final_best_fitness": result.final_best_fitness,
        "best_genome": result.best_genome,
        "runtime_seconds": result.runtime_seconds,
        "evaluations": result.evaluations,
        "curve": [{"n_evaluations": p.n_evaluations, "best_fitness_so_far": p.best_fitness_so_far}
                  for p in result.curve],
    }


@router.post("/benchmark", response_model=api_schemas.JobStartResponse)
def start_benchmark(body: api_schemas.BenchmarkRequest, user: _db.User = Depends(get_current_user)
                     ) -> api_schemas.JobStartResponse:
    try:
        base_config = ModelConfig.from_dict(body.model).validate()
        evo_config = EvolutionConfig.from_dict(body.evolution).validate()
        mo_config = MultiObjectiveConfig.from_dict(body.multiobjective).validate()
    except ConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    job = job_store.create_job(kind="benchmark", owner_id=user.id)

    def _target(job: job_store.Job) -> dict:
        ga = run_ga_benchmark(base_config, evo_config)
        nsga2 = run_nsga2_benchmark(base_config, mo_config)
        budget = budget_evaluations(evo_config.population_size, evo_config.generations, evo_config.eval_seeds)
        rs = run_random_search(base_config, evo_config.free_genes, eval_seeds=evo_config.eval_seeds,
                                n_evaluations=budget, seed=evo_config.seed)
        al_config = active_learning_config_for_budget(
            budget, evo_config.eval_seeds, evo_config.free_genes, seed=evo_config.seed,
        )
        al = run_active_learning_benchmark(base_config, al_config)

        results = [ga, nsga2, rs, al]
        frame = combined_frame(results)
        return {
            "results": [_result_to_dict(r.method, r) for r in results],
            "combined": frame.to_dict(orient="records"),
        }

    job_store.run_job(job, _target)
    return api_schemas.JobStartResponse(job_id=job.job_id)
