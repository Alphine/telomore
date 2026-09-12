"""Application service layer (SDD §5.4): run / compare / evolve / export.

Used identically by the CLI scripts and the FastAPI routers (``backend/``)
so both paths produce the same artifacts and registry records.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

from ..adapters.published_model import TelomereModelAdapter, get_model
from ..evolution.engine import EvolutionEngine, EvolutionResult, GenerationRecord
from ..evolution.fitness import FitnessBreakdown, compute_fitness
from ..schemas import EvolutionConfig, FitnessWeights, ModelConfig, SimulationResult
from .artifacts import write_evolution_artifacts, write_simulation_artifacts
from .registry import ExperimentRegistry

_SIM_CACHE: Dict[str, SimulationResult] = {}
_SIM_CACHE_LIMIT = 256


def _cache_key(config: ModelConfig, model_name: str, version: str) -> str:
    # SDD §19: model_version + parameter_hash + random_seed + simulator name
    return f"{model_name}:{version}:{config.config_hash()}:{config.seed}"


def run_simulation(
    config: ModelConfig,
    model: Optional[TelomereModelAdapter] = None,
    use_cache: bool = True,
) -> SimulationResult:
    model = model or get_model()
    key = _cache_key(config, model.name, model.version)
    if use_cache and key in _SIM_CACHE:
        return _SIM_CACHE[key]
    result = model.simulate(config)
    if use_cache:
        if len(_SIM_CACHE) >= _SIM_CACHE_LIMIT:
            _SIM_CACHE.pop(next(iter(_SIM_CACHE)))
        _SIM_CACHE[key] = result
    return result


def score(result: SimulationResult, weights: Optional[FitnessWeights] = None) -> FitnessBreakdown:
    return compute_fitness(result, weights or FitnessWeights())


def record_simulation(
    result: SimulationResult,
    registry: Optional[ExperimentRegistry] = None,
    weights: Optional[FitnessWeights] = None,
    notes: str = "",
) -> dict:
    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id()
    artifacts = write_simulation_artifacts(result, registry.run_dir(run_id))
    bd = score(result, weights)
    return registry.register(
        kind="simulation",
        run_id=run_id,
        seed=result.seed,
        configuration={"model": result.config.to_dict(),
                       "weights": (weights or FitnessWeights()).to_dict()},
        fitness=bd.total if bd.valid else None,
        artifacts=artifacts,
        runtime_seconds=result.runtime_seconds,
        notes=notes,
        extra={"terminal_metrics": result.terminal_metrics, "valid": result.valid,
               "failure_reason": result.failure_reason},
    )


def run_ensemble(
    base_config: ModelConfig,
    seeds: Sequence[int],
    model: Optional[TelomereModelAdapter] = None,
) -> List[SimulationResult]:
    """Run the existing, unmodified ``simulate()`` once per seed (ROADMAP.md
    candidate feature #2: ensemble / uncertainty visualization).

    A simple Python loop: each run is sub-second (``test_runtime_target_default_config``),
    so multiprocessing is not worth the added complexity at the API's n_seeds<=50
    cap -- revisit only if a measured runtime becomes a real problem.
    """
    model = model or get_model()
    return [model.simulate(base_config.replace(seed=int(s))) for s in seeds]


def summarize_ensemble(results: Sequence[SimulationResult]) -> Dict[str, Any]:
    """p10 / p50 (median) / p90 + mean of ``mean_length`` across seeds, computed
    independently at each cycle.

    Percentiles are taken *per cycle*, not per seed-trajectory: the p10 curve at
    cycle 5 and the p10 curve at cycle 50 may come from different seeds. This is
    an honest, distribution-free description of the spread across independent
    stochastic realizations of the same configuration -- it is NOT a confidence
    band around any single seed's path, and (docs/SCIENTIFIC_SCOPE.md) it says
    nothing about biological population variability beyond the model's own
    per-division noise term.
    """
    valid = [r for r in results if r.valid]
    if not valid:
        return {"cycle": [], "p10": [], "p50": [], "p90": [], "mean": []}
    n = len(valid[0].mean_length)
    cycle = valid[0].time.tolist()
    stacked = np.stack([r.mean_length for r in valid if len(r.mean_length) == n])
    return {
        "cycle": cycle,
        "p10": np.percentile(stacked, 10, axis=0).tolist(),
        "p50": np.percentile(stacked, 50, axis=0).tolist(),
        "p90": np.percentile(stacked, 90, axis=0).tolist(),
        "mean": np.mean(stacked, axis=0).tolist(),
    }


def record_ensemble(
    base_config: ModelConfig,
    results: Sequence[SimulationResult],
    seeds: Sequence[int],
    registry: Optional[ExperimentRegistry] = None,
    weights: Optional[FitnessWeights] = None,
    notes: str = "",
) -> dict:
    """Register exactly ONE ledger entry for the whole ensemble (not N)."""
    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id()
    weights = weights or FitnessWeights()
    breakdowns = [score(r, weights) for r in results]
    valid_totals = [bd.total for bd in breakdowns if bd.valid]
    mean_fitness = float(np.mean(valid_totals)) if valid_totals else None
    return registry.register(
        kind="ensemble",
        run_id=run_id,
        seed=int(seeds[0]),
        configuration={
            "model": base_config.to_dict(),
            "weights": weights.to_dict(),
            "n_seeds": len(seeds),
            "seeds": [int(s) for s in seeds],
        },
        fitness=mean_fitness,
        runtime_seconds=float(sum(r.runtime_seconds for r in results)),
        notes=notes or f"ensemble of {len(seeds)} seeds",
        extra={
            "n_seeds": len(seeds),
            "seeds": [int(s) for s in seeds],
            "n_valid": len(valid_totals),
            "n_invalid": len(results) - len(valid_totals),
        },
    )


def run_evolution(
    base_config: ModelConfig,
    evo_config: EvolutionConfig,
    registry: Optional[ExperimentRegistry] = None,
    callback: Optional[Callable[[GenerationRecord], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    model: Optional[TelomereModelAdapter] = None,
    notes: str = "",
    register: bool = True,
    n_workers: int = 1,
) -> tuple[EvolutionResult, Optional[dict]]:
    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id() if register else None
    run_dir = registry.run_dir(run_id) if run_id else None
    engine = EvolutionEngine(base_config, evo_config, model=model, run_dir=run_dir, n_workers=n_workers)
    result = engine.run(callback=callback, should_stop=should_stop)
    record = None
    if register and run_id:
        artifacts = write_evolution_artifacts(result, run_dir)
        record = registry.register(
            kind="evolution",
            run_id=run_id,
            seed=evo_config.seed,
            configuration={"model": base_config.to_dict(), "evolution": evo_config.to_dict()},
            fitness=result.best.fitness,
            artifacts=artifacts,
            runtime_seconds=result.runtime_seconds,
            notes=notes,
            extra={
                "baseline_fitness": result.baseline.fitness,
                "best_genome": result.best.genome,
                "evaluations": result.evaluations,
                "generations_completed": len(result.history) - 1,
                "stopped_early": result.stopped_early,
                "stop_reason": result.stop_reason,
            },
        )
    return result, record


def run_pareto(
    base_config: ModelConfig,
    mo_config,
    registry: Optional[ExperimentRegistry] = None,
    callback=None,
    should_stop: Optional[Callable[[], bool]] = None,
    model: Optional[TelomereModelAdapter] = None,
    notes: str = "",
    register: bool = True,
):
    """Run NSGA-II and (optionally) register the Pareto front in the ledger."""
    from ..evolution.multiobjective import NSGA2Engine
    from .artifacts import write_pareto_artifacts

    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id() if register else None
    run_dir = registry.run_dir(run_id) if run_id else None
    engine = NSGA2Engine(base_config, mo_config, model=model, run_dir=run_dir)
    result = engine.run(callback=callback, should_stop=should_stop)
    record = None
    if register and run_id:
        artifacts = write_pareto_artifacts(result, run_dir)
        best_scalar = max(result.front, key=lambda c: c.scalar_fitness) if result.front else None
        record = registry.register(
            kind="pareto",
            run_id=run_id,
            seed=mo_config.seed,
            configuration={"model": base_config.to_dict(), "multiobjective": mo_config.to_dict()},
            fitness=best_scalar.scalar_fitness if best_scalar else None,
            artifacts=artifacts,
            runtime_seconds=result.runtime_seconds,
            notes=notes,
            extra={
                "algorithm": "NSGA-II",
                "objectives": list(mo_config.objectives),
                "front_size": len(result.front),
                "final_hypervolume": result.history[-1].hypervolume if result.history else None,
                "front": [{"genome": c.genome, "objectives": c.objectives} for c in result.front],
                "evaluations": result.evaluations,
                "generations_completed": len(result.history) - 1,
                "stopped_early": result.stopped_early,
            },
        )
    return result, record


def run_sensitivity(
    base_config: ModelConfig,
    sensitivity_config,
    registry: Optional[ExperimentRegistry] = None,
    callback=None,
    model: Optional[TelomereModelAdapter] = None,
    notes: str = "",
    register: bool = True,
):
    """Run OAT sensitivity analysis and (optionally) register it in the ledger."""
    from ..analysis.sensitivity import run_sensitivity_analysis
    from .artifacts import write_sensitivity_artifacts

    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id() if register else None
    result = run_sensitivity_analysis(base_config, sensitivity_config, model=model, callback=callback)
    record = None
    if register and run_id:
        run_dir = registry.run_dir(run_id)
        artifacts = write_sensitivity_artifacts(result, run_dir)
        top = max(result.items, key=lambda it: abs(it.swing)) if result.items else None
        record = registry.register(
            kind="sensitivity",
            run_id=run_id,
            seed=next(iter(sensitivity_config.eval_seeds)),
            configuration={"model": base_config.to_dict(), "sensitivity": sensitivity_config.to_dict()},
            fitness=result.baseline_fitness,
            artifacts=artifacts,
            runtime_seconds=result.runtime_seconds,
            notes=notes,
            extra={
                "most_sensitive_parameter": top.parameter if top else None,
                "max_swing": top.swing if top else None,
                "evaluations": result.evaluations,
            },
        )
    return result, record


def run_active_learning(
    base_config: ModelConfig,
    al_config,
    registry: Optional[ExperimentRegistry] = None,
    callback=None,
    model: Optional[TelomereModelAdapter] = None,
    notes: str = "",
    register: bool = True,
):
    """Run surrogate-model active learning and (optionally) register it in the ledger."""
    from ..evolution.surrogate import run_active_learning as _run_active_learning
    from .artifacts import write_active_learning_artifacts

    registry = registry or ExperimentRegistry()
    run_id = registry.new_run_id() if register else None
    result = _run_active_learning(base_config, al_config, model=model, callback=callback)
    record = None
    if register and run_id:
        run_dir = registry.run_dir(run_id)
        artifacts = write_active_learning_artifacts(result, run_dir)
        record = registry.register(
            kind="active_learning",
            run_id=run_id,
            seed=al_config.seed,
            configuration={"model": base_config.to_dict(), "active_learning": al_config.to_dict()},
            fitness=result.best_fitness,
            artifacts=artifacts,
            runtime_seconds=result.runtime_seconds,
            notes=notes,
            extra={
                "best_genome": result.best_genome,
                "evaluations": result.evaluations,
                "n_initial": al_config.n_initial,
                "n_iterations": al_config.n_iterations,
            },
        )
    return result, record


@dataclass
class ScenarioComparison:
    name: str
    config: ModelConfig
    result: SimulationResult
    breakdown: FitnessBreakdown


def compare_scenarios(
    scenarios: Dict[str, ModelConfig],
    weights: Optional[FitnessWeights] = None,
    model: Optional[TelomereModelAdapter] = None,
) -> List[ScenarioComparison]:
    out = []
    for name, cfg in scenarios.items():
        res = run_simulation(cfg, model=model)
        out.append(ScenarioComparison(name, cfg, res, score(res, weights)))
    return out


def deltas(baseline: ScenarioComparison, other: ScenarioComparison) -> Dict[str, float]:
    """Headline deltas shown on the Compare page (SDD §16 page 3)."""
    b, o = baseline, other
    bt, ot = b.result.terminal_metrics, o.result.terminal_metrics
    fit_delta_pct = (
        (o.breakdown.total - b.breakdown.total) / abs(b.breakdown.total) * 100.0
        if b.breakdown.total not in (0.0,) and b.breakdown.valid and o.breakdown.valid
        else float("nan")
    )
    return {
        "fitness_abs": o.breakdown.total - b.breakdown.total,
        "fitness_pct": fit_delta_pct,
        "senescence_pp": (ot.get("final_senescent_fraction", 1.0)
                          - bt.get("final_senescent_fraction", 1.0)) * 100.0,
        "reserve_kb": (ot.get("telomere_reserve_bp", 0.0) - bt.get("telomere_reserve_bp", 0.0)) / 1000.0,
        "mean_length_kb": (ot.get("final_mean_length_bp", 0.0) - bt.get("final_mean_length_bp", 0.0)) / 1000.0,
        "survival_abs": ot.get("normalized_survival", 0.0) - bt.get("normalized_survival", 0.0),
    }
