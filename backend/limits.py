"""Request-size limits for the public API (never applied to the core library).

Everything here lives in the backend request layer on purpose: scientists
running ``telomere_lab`` from scripts keep unrestricted access, and
``ModelConfig.validate()`` is untouched.

Each limit is read from an environment variable at call time (so tests and
operators can change it without a restart-time import order problem).
A value ``<= 0`` (or ``off``/``none``/``unlimited``) disables that single
limit; ``TELOMERE_DISABLE_LIMITS=1`` switches every limit in this module off
(size caps, cost budgets, job caps) -- intended for a local, single-user
install. See docs/API.md, "Limits and security notes".

Cost model: one simulation run costs roughly ``carrying_capacity x
telomeres_per_cell x cycles`` cell-telomere-cycles (measured ~0.055 s per
million on a laptop CPU). A job's cost is that times the number of
simulator runs it triggers (population x generations x eval_seeds for the
GA, etc.).
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import HTTPException

_OFF_WORDS = {"off", "none", "unlimited", "false", "no", "0", ""}
_ON_WORDS = {"1", "true", "yes", "on"}


def disabled() -> bool:
    return os.environ.get("TELOMERE_DISABLE_LIMITS", "").strip().lower() in _ON_WORDS


def get_limit(env: str, default: float) -> Optional[float]:
    """Effective limit for ``env`` (``None`` = unlimited)."""
    if disabled():
        return None
    raw = os.environ.get(env)
    if raw is None:
        return default
    raw = raw.strip().lower()
    if raw in _OFF_WORDS:
        return None
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else None


# (config field, env var, default) -- defaults sit above the frontend form
# maxima (1x population 2000, capacity 5000, cycles 600, telomeres 92) and every configs/*.yaml.
MODEL_LIMITS = {
    "population_size": ("TELOMERE_MAX_POPULATION_SIZE", 5000),
    "carrying_capacity": ("TELOMERE_MAX_CARRYING_CAPACITY", 20000),
    "telomeres_per_cell": ("TELOMERE_MAX_TELOMERES_PER_CELL", 92),
    "cycles": ("TELOMERE_MAX_CYCLES", 1000),
}
OPTIMIZER_LIMITS = {
    "population_size": ("TELOMERE_MAX_GA_POPULATION", 200),
    "generations": ("TELOMERE_MAX_GA_GENERATIONS", 200),
    "n_initial": ("TELOMERE_MAX_AL_ITERATIONS", 200),
    "n_iterations": ("TELOMERE_MAX_AL_ITERATIONS", 200),
    "candidate_pool_size": ("TELOMERE_MAX_CANDIDATE_POOL", 5000),
}
ENV_MAX_EVAL_SEEDS = ("TELOMERE_MAX_EVAL_SEEDS", 20)
ENV_MAX_RUN_COST = ("TELOMERE_MAX_RUN_COST", 3.0e8)     # ~16 s single run
ENV_MAX_JOB_COST = ("TELOMERE_MAX_JOB_COST", 3.0e10)    # ~30 min per job
ENV_MAX_LIST = ("TELOMERE_MAX_LIST_ITEMS", 50)          # subclones / genotypes / environments / parameters


def _too_big(what: str, value: Any, limit: float, env: str) -> HTTPException:
    return HTTPException(
        422,
        f"{what} = {value} exceeds the server limit of {int(limit) if float(limit).is_integer() else limit:g} "
        f"(env var {env}). Reduce it or run the library locally for larger jobs.",
    )


def _check(what: str, value: Any, spec) -> None:
    env, default = spec
    limit = get_limit(env, default)
    if limit is None or value is None:
        return
    try:
        v = float(value)
    except (TypeError, ValueError):
        return
    if v > limit:
        raise _too_big(what, value, limit, env)


def _len(seq) -> int:
    try:
        return len(seq)
    except TypeError:
        return 0


def check_model(cfg) -> float:
    """Bound a validated ``ModelConfig``; returns the cost of one run."""
    for name, spec in MODEL_LIMITS.items():
        _check(f"model.{name}", getattr(cfg, name), spec)
    _check("subclones", _len(cfg.subclones or ()), ENV_MAX_LIST)
    cost = float(cfg.carrying_capacity) * float(cfg.telomeres_per_cell) * float(cfg.cycles)
    _check("estimated cost of one simulation run (carrying_capacity x telomeres_per_cell x cycles)", cost, ENV_MAX_RUN_COST)
    return cost


def check_job_cost(run_cost: float, n_runs: float, label: str = "job") -> None:
    _check(f"estimated {label} cost (simulator runs x cells x telomeres x cycles; {int(n_runs)} runs)",
           run_cost * n_runs, ENV_MAX_JOB_COST)


def check_optimizer(cfg, label: str) -> None:
    for name, spec in OPTIMIZER_LIMITS.items():
        if hasattr(cfg, name):
            _check(f"{label}.{name}", getattr(cfg, name), spec)
    if hasattr(cfg, "eval_seeds"):
        _check(f"{label}.eval_seeds (count)", _len(cfg.eval_seeds), ENV_MAX_EVAL_SEEDS)


# --- per-endpoint helpers: each returns nothing, raises HTTPException(422) --- #
def check_simulate(model) -> None:
    check_model(model)


def check_ensemble(model, n_seeds: int) -> None:
    check_job_cost(check_model(model), n_seeds, "ensemble")


def check_compare(models) -> None:
    total = sum(check_model(m) for m in models)
    check_job_cost(total, 1, "comparison")


def check_evolve(model, evo, label: str = "evolution") -> float:
    check_optimizer(evo, label)
    run_cost = check_model(model)
    n_runs = evo.population_size * (evo.generations + 1) * max(1, _len(evo.eval_seeds)) + _len(evo.eval_seeds)
    check_job_cost(run_cost, n_runs, label)
    return n_runs * run_cost


def check_pareto(model, mo) -> None:
    check_evolve(model, mo, "multiobjective")


def check_sensitivity(model, sens) -> None:
    run_cost = check_model(model)
    _check("sensitivity.parameters (count)", _len(sens.parameters), ENV_MAX_LIST)
    _check("sensitivity.eval_seeds (count)", _len(sens.eval_seeds), ENV_MAX_EVAL_SEEDS)
    check_job_cost(run_cost, (2 * _len(sens.parameters) + 1) * max(1, _len(sens.eval_seeds)), "sensitivity")


def check_gxe(model, gxe) -> None:
    run_cost = check_model(model)
    _check("gxe.genotypes (count)", _len(gxe.genotypes), ENV_MAX_LIST)
    _check("gxe.environments (count)", _len(gxe.environments), ENV_MAX_LIST)
    _check("gxe.eval_seeds (count)", _len(gxe.eval_seeds), ENV_MAX_EVAL_SEEDS)
    check_job_cost(run_cost, max(1, _len(gxe.genotypes)) * max(1, _len(gxe.environments))
                   * max(1, _len(gxe.eval_seeds)), "GxE")


def check_active_learning(model, al) -> None:
    run_cost = check_model(model)
    check_optimizer(al, "active_learning")
    check_job_cost(run_cost, (al.n_initial + al.n_iterations) * max(1, _len(al.eval_seeds)), "active-learning")


def check_benchmark(model, evo, mo) -> None:
    ga = check_evolve(model, evo, "evolution")
    nsga = check_evolve(model, mo, "multiobjective")
    # GA + NSGA-II + random search and active learning at the GA's evaluation budget
    check_job_cost(1.0, ga * 3 + nsga, "benchmark")
