"""Budget-matched benchmark: GA vs. NSGA-II vs. random search.

All three methods are compared on the same scalar fitness
(``evolution.fitness.compute_fitness``, the GA's objective) so their
convergence curves share one y-axis. NSGA-II does not optimise this scalar
directly -- it keeps a whole Pareto front -- so its curve is the *best single
front/population point*'s reference scalar fitness (``MultiObjectiveConfig
.weights``, computed alongside each candidate's objectives but not used for
NSGA-II's own selection). Hypervolume was the other option (SDD-adjacent
choice); it was not used here because it is on a different scale entirely
and cannot share an axis with the GA's fitness without an extra normalisation
step. Random search samples genomes uniformly from the same gene bounds used
by the GA/NSGA-II genome encoding (``GenomeSpec``) and is budget-matched by
total simulator calls (``budget_evaluations``).
"""

from __future__ import annotations

import json
import tempfile
import time as _time
from dataclasses import dataclass, replace as _replace
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np

from ..schemas import FitnessWeights, ModelConfig, MultiObjectiveConfig
from ..simulator.model import SimpleTelomereModel
from .engine import EvolutionEngine
from .fitness import average_breakdowns, compute_fitness
from .genome import GenomeSpec
from .multiobjective import NSGA2Engine


@dataclass
class ConvergencePoint:
    n_evaluations: int
    best_fitness_so_far: float


@dataclass
class BenchmarkResult:
    method: str
    curve: List[ConvergencePoint]
    final_best_fitness: float
    best_genome: Dict[str, float]
    runtime_seconds: float
    evaluations: int

    def to_frame(self):
        import pandas as pd

        return pd.DataFrame({
            "method": self.method,
            "n_evaluations": [p.n_evaluations for p in self.curve],
            "best_fitness_so_far": [p.best_fitness_so_far for p in self.curve],
        })


def combined_frame(results: Sequence[BenchmarkResult]):
    """Long-format frame (method, n_evaluations, best_fitness_so_far) for a line chart."""
    import pandas as pd

    if not results:
        return pd.DataFrame(columns=["method", "n_evaluations", "best_fitness_so_far"])
    return pd.concat([r.to_frame() for r in results], ignore_index=True)


def budget_evaluations(population_size: int, generations: int, eval_seeds: Sequence[int]) -> int:
    """Upper bound on simulator calls a GA/NSGA-II run of this shape uses (ignores the
    small savings from genome-cache hits on duplicate genomes). Used to size a matched
    random-search budget."""
    return population_size * (generations + 1) * len(eval_seeds)


# --------------------------------------------------------------- random search
def run_random_search(
    base_config: ModelConfig,
    free_genes: Sequence[str],
    weights: Optional[FitnessWeights] = None,
    eval_seeds: Sequence[int] = (1, 2, 3),
    n_evaluations: int = 800,
    seed: int = 0,
    model: Optional[SimpleTelomereModel] = None,
) -> BenchmarkResult:
    """Sample genomes uniformly from the gene bounds (``GenomeSpec``); each sample costs
    ``len(eval_seeds)`` simulator calls, same as one GA/NSGA-II candidate evaluation."""
    base_config = base_config.validate()
    weights = weights or FitnessWeights()
    eval_seeds = tuple(eval_seeds)
    spec = GenomeSpec(base_config, free_genes)
    model = model or SimpleTelomereModel()
    rng = np.random.default_rng(seed)
    n_candidates = max(1, n_evaluations // len(eval_seeds))

    t0 = _time.perf_counter()
    curve: List[ConvergencePoint] = []
    best_fitness = -np.inf
    best_genome: Dict[str, float] = {}
    total_evals = 0
    for _ in range(n_candidates):
        genome = spec.random_genome(rng)
        breakdowns = [compute_fitness(model.simulate(spec.to_config(genome, seed=int(s))), weights)
                     for s in eval_seeds]
        total_evals += len(eval_seeds)
        bd = average_breakdowns(breakdowns)
        if bd.valid and bd.total > best_fitness:
            best_fitness, best_genome = bd.total, dict(genome)
        shown = float(best_fitness) if np.isfinite(best_fitness) else float("nan")
        curve.append(ConvergencePoint(total_evals, shown))

    return BenchmarkResult(
        method="random_search", curve=curve,
        final_best_fitness=float(best_fitness) if np.isfinite(best_fitness) else float("nan"),
        best_genome=best_genome, runtime_seconds=_time.perf_counter() - t0, evaluations=total_evals,
    )


# --------------------------------------------------------------------------- GA
def run_ga_benchmark(base_config: ModelConfig, evo_config, model: Optional[SimpleTelomereModel] = None
                     ) -> BenchmarkResult:
    model = model or SimpleTelomereModel()
    t0 = _time.perf_counter()
    result = EvolutionEngine(base_config, evo_config, model=model).run()
    curve = [ConvergencePoint(h.evaluations_so_far, h.best_fitness) for h in result.history]
    return BenchmarkResult(
        method="GA", curve=curve, final_best_fitness=result.best.fitness,
        best_genome=dict(result.best.genome), runtime_seconds=_time.perf_counter() - t0,
        evaluations=result.evaluations,
    )


# ----------------------------------------------------------------------- NSGA-II
def run_nsga2_benchmark(base_config: ModelConfig, mo_config: MultiObjectiveConfig,
                        weights: Optional[FitnessWeights] = None,
                        model: Optional[SimpleTelomereModel] = None) -> BenchmarkResult:
    """Reduce the Pareto front to a single convergence curve using the reference scalar
    fitness (see module docstring). Reuses ``NSGA2Engine``'s own checkpointing (rather
    than duplicating its selection loop) to read back each generation's population."""
    weights = weights or mo_config.weights
    cfg = _replace(mo_config, checkpoint_every=1)
    model = model or SimpleTelomereModel()
    t0 = _time.perf_counter()
    with tempfile.TemporaryDirectory() as tmp:
        engine = NSGA2Engine(base_config, cfg, model=model, run_dir=tmp)
        result = engine.run()
        curve: List[ConvergencePoint] = []
        for rec in result.history:
            payload = json.loads((Path(tmp) / f"generation_{rec.generation:03d}.json")
                                 .read_text(encoding="utf-8"))
            scalars = [c["scalar_fitness"] for c in payload["population"] if c.get("valid")]
            best = max(scalars) if scalars else float("nan")
            curve.append(ConvergencePoint(rec.evaluations_so_far, float(best)))

    finite = [p.best_fitness_so_far for p in curve if np.isfinite(p.best_fitness_so_far)]
    best_candidate = max(result.front, key=lambda c: c.scalar_fitness) if result.front else None
    return BenchmarkResult(
        method="NSGA-II", curve=curve, final_best_fitness=max(finite) if finite else float("nan"),
        best_genome=dict(best_candidate.genome) if best_candidate else {},
        runtime_seconds=_time.perf_counter() - t0, evaluations=result.evaluations,
    )
