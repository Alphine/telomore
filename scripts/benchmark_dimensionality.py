"""CLI: does optimizer search quality degrade as genome dimensionality grows?

Reuses the exact budget-matched benchmark machinery from
``evolution/benchmark.py`` / ``scripts/benchmark_optimizers.py`` (no new
optimizer code) at a sweep of genome sizes instead of a single fixed one:

  - "genes=N" levels: prefix subsets of ``EVOLVABLE_PARAMETERS`` (3, 5, 7, 10
    genes), ``schedule_phases=1``.
  - "K=N" levels: the full 10-gene set with ``schedule_phases`` in {2, 4, 8},
    which expands the 3 ``SCHEDULABLE_PARAMETERS`` into N genes each (7 fixed
    + 3*K scheduled genes -> 13, 19, 31).

Both axes share the "genes=10 (K=1)" anchor, giving one continuous
dimensionality axis: 3 -> 5 -> 7 -> 10 -> 13 -> 19 -> 31 genes.

The simulator-call budget (GA population*[generations+1]*eval_seeds) is held
IDENTICAL across every dimensionality level for every method -- the whole
point is "same budget, does the problem get harder", not "bigger genome gets
more budget". Each (level, method) cell is repeated over several optimizer
seeds and reported as mean +/- SD final_best_fitness, since GA/random
search/active learning are all stochastic.

    python scripts/benchmark_dimensionality.py
    python scripts/benchmark_dimensionality.py --seeds 11 12 13 --population 24 --generations 15
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, replace as _replace
from pathlib import Path
from statistics import mean, pstdev
from typing import Dict, List, Sequence

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import REPORTS_DIR, load_evolution_config  # noqa: E402
from telomere_lab.evolution.benchmark import (  # noqa: E402
    active_learning_config_for_budget,
    budget_evaluations,
    run_active_learning_benchmark,
    run_ga_benchmark,
    run_random_search,
)
from telomere_lab.evolution.genome import GenomeSpec  # noqa: E402
from telomere_lab.experiments.registry import environment_metadata, _json_default  # noqa: E402
from telomere_lab.schemas import EVOLVABLE_PARAMETERS  # noqa: E402

# Prefix subsets of EVOLVABLE_PARAMETERS -- each extends the previous one, so
# the "genes=N" levels form a genuine nested sequence, not unrelated sets.
_GENE_ORDER = (
    "stress_level", "maintenance_rate", "repair_rate",             # culture-condition genes (default free_genes)
    "initial_length", "senescence_threshold",                       # + initial-condition / threshold genes
    "shortening_rate", "replication_error_rate",                    # + biophysics / genome-stability rate genes
    "oxidative_mutation_sensitivity", "checkpoint_strength", "mutation_threshold",  # + remaining genome-stability genes
)
assert set(_GENE_ORDER) == set(EVOLVABLE_PARAMETERS), "gene order must cover every evolvable parameter exactly once"

GENE_SUBSET_LEVELS = (3, 5, 7, 10)          # -> free_genes prefix length, schedule_phases=1
SCHEDULE_PHASE_LEVELS = (2, 4, 8)           # -> full 10-gene set, schedule_phases=K


@dataclass
class DimensionalityLevel:
    label: str
    free_genes: Sequence[str]
    schedule_phases: int
    n_genes: int  # actual GenomeSpec gene count, incl. phase expansion


def build_levels() -> List[DimensionalityLevel]:
    levels = []
    for n in GENE_SUBSET_LEVELS:
        genes = _GENE_ORDER[:n]
        levels.append(DimensionalityLevel(f"genes={n}", genes, 1, n))
    for k in SCHEDULE_PHASE_LEVELS:
        n_scheduled = 3 * k  # stress_level, maintenance_rate, repair_rate
        n_fixed = len(EVOLVABLE_PARAMETERS) - 3
        levels.append(DimensionalityLevel(f"K={k}", _GENE_ORDER, k, n_fixed + n_scheduled))
    return levels


@dataclass
class CellResult:
    level: str
    n_genes: int
    method: str
    seeds: List[int]
    final_best_fitness: List[float]

    @property
    def mean(self) -> float:
        finite = [f for f in self.final_best_fitness if np.isfinite(f)]
        return mean(finite) if finite else float("nan")

    @property
    def sd(self) -> float:
        finite = [f for f in self.final_best_fitness if np.isfinite(f)]
        return pstdev(finite) if len(finite) > 1 else 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/evolution.yaml", help="base model + GA hyperparameters")
    ap.add_argument("--population", type=int, default=24)
    ap.add_argument("--generations", type=int, default=15)
    ap.add_argument("--seeds", type=int, nargs="+", default=[11, 12, 13],
                     help="optimizer seeds repeated per (level, method) cell")
    args = ap.parse_args(argv)

    base, evo = load_evolution_config(args.config)
    evo = _replace(evo, population_size=args.population, generations=args.generations, checkpoint_every=0)

    budget = budget_evaluations(evo.population_size, evo.generations, evo.eval_seeds)
    levels = build_levels()

    print(f"Budget held fixed across every level: {budget} simulator calls "
          f"(population {evo.population_size} x generations {evo.generations} x "
          f"eval_seeds {evo.eval_seeds})")
    print(f"Dimensionality levels: {[(lv.label, lv.n_genes) for lv in levels]}")
    print(f"Seeds per (level, method) cell: {args.seeds}")
    print("-" * 78)

    cells: List[CellResult] = []
    t_start = time.perf_counter()
    for lv in levels:
        # Sanity-check the actual gene count matches what we expect before spending budget on it.
        actual_n = len(GenomeSpec(base, lv.free_genes, schedule_phases=lv.schedule_phases))
        assert actual_n == lv.n_genes, f"{lv.label}: expected {lv.n_genes} genes, GenomeSpec built {actual_n}"

        for method in ("GA", "random_search", "active_learning"):
            fitnesses = []
            for seed in args.seeds:
                t0 = time.perf_counter()
                if method == "GA":
                    evo_run = _replace(evo, free_genes=tuple(lv.free_genes), schedule_phases=lv.schedule_phases,
                                        seed=seed)
                    result = run_ga_benchmark(base, evo_run)
                elif method == "random_search":
                    result = run_random_search(base, lv.free_genes, weights=evo.weights, eval_seeds=evo.eval_seeds,
                                                n_evaluations=budget, seed=seed, schedule_phases=lv.schedule_phases)
                else:
                    al_config = active_learning_config_for_budget(
                        budget, evo.eval_seeds, lv.free_genes, weights=evo.weights, seed=seed,
                    )
                    al_config = _replace(al_config, schedule_phases=lv.schedule_phases)
                    result = run_active_learning_benchmark(base, al_config)
                fitnesses.append(result.final_best_fitness)
                print(f"  {lv.label:<10} n_genes={lv.n_genes:>2}  {method:<15} seed={seed:<4} "
                      f"best={result.final_best_fitness:+.4f}  ({time.perf_counter() - t0:.1f}s)")
            cells.append(CellResult(lv.label, lv.n_genes, method, list(args.seeds), fitnesses))

    print("-" * 78)
    print(f"Total runtime: {time.perf_counter() - t_start:.1f}s")
    print(f"{'level':<10}{'n_genes':>9}{'method':<17}{'mean_best_fitness':>19}{'sd':>9}")
    for c in cells:
        print(f"{c.level:<10}{c.n_genes:>9}{c.method:<17}{c.mean:>19.4f}{c.sd:>9.4f}")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / "benchmark_dimensionality.json"
    payload = {
        "environment": environment_metadata(),
        "base_config": base.to_dict(),
        "budget_evaluations": budget,
        "ga_population": evo.population_size,
        "ga_generations": evo.generations,
        "seeds": list(args.seeds),
        "cells": [
            {"level": c.level, "n_genes": c.n_genes, "method": c.method, "seeds": c.seeds,
             "final_best_fitness": c.final_best_fitness, "mean": c.mean, "sd": c.sd}
            for c in cells
        ],
    }
    out.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")

    import pandas as pd
    pd.DataFrame([
        {"level": c.level, "n_genes": c.n_genes, "method": c.method, "seed": s, "final_best_fitness": f}
        for c in cells for s, f in zip(c.seeds, c.final_best_fitness)
    ]).to_csv(REPORTS_DIR / "benchmark_dimensionality.csv", index=False)
    print(f"Report written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
