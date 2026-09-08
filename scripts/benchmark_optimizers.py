"""CLI: budget-matched comparison of GA, NSGA-II, random search and surrogate active learning.

Distinct from ``scripts/benchmark.py`` (which times the simulator/GA for
*speed*). This one compares optimizer *quality* under a matched simulation
budget and writes the comparison to ``experiments/reports/``.

    python scripts/benchmark_optimizers.py
    python scripts/benchmark_optimizers.py --config configs/evolution.yaml --generations 15
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import REPORTS_DIR, load_evolution_config  # noqa: E402
from telomere_lab.evolution.benchmark import (  # noqa: E402
    active_learning_config_for_budget,
    budget_evaluations,
    combined_frame,
    run_active_learning_benchmark,
    run_ga_benchmark,
    run_nsga2_benchmark,
    run_random_search,
)
from telomere_lab.experiments.registry import environment_metadata, _json_default  # noqa: E402
from telomere_lab.schemas import MultiObjectiveConfig  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/evolution.yaml", help="model + evolution config (GA settings)")
    ap.add_argument("--population", type=int, default=None)
    ap.add_argument("--generations", type=int, default=None)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    base, evo = load_evolution_config(args.config)
    evo.seed = args.seed
    if args.population is not None:
        evo.population_size = args.population
    if args.generations is not None:
        evo.generations = args.generations
    evo.checkpoint_every = 0
    evo.validate()

    mo = MultiObjectiveConfig(
        population_size=evo.population_size, generations=evo.generations, mutation_rate=evo.mutation_rate,
        mutation_sigma=evo.mutation_sigma, crossover_rate=evo.crossover_rate, crossover_kind=evo.crossover_kind,
        seed=evo.seed, eval_seeds=evo.eval_seeds, free_genes=evo.free_genes,
        objectives=("survival", "cost"), weights=evo.weights, checkpoint_every=0,
    ).validate()

    print(f"GA:       population {evo.population_size}  generations {evo.generations}  "
          f"eval_seeds {evo.eval_seeds}")
    t0 = time.perf_counter()
    ga = run_ga_benchmark(base, evo)
    print(f"  done in {time.perf_counter() - t0:.1f}s  evaluations {ga.evaluations}  "
          f"best {ga.final_best_fitness:+.4f}")

    print(f"NSGA-II:  population {mo.population_size}  generations {mo.generations}  objectives {mo.objectives}")
    t0 = time.perf_counter()
    nsga2 = run_nsga2_benchmark(base, mo, weights=evo.weights)
    print(f"  done in {time.perf_counter() - t0:.1f}s  evaluations {nsga2.evaluations}  "
          f"best {nsga2.final_best_fitness:+.4f}")

    budget = max(ga.evaluations, nsga2.evaluations, budget_evaluations(evo.population_size, evo.generations,
                                                                       evo.eval_seeds))
    print(f"Random search: budget-matched to {budget} simulator calls")
    t0 = time.perf_counter()
    rs = run_random_search(base, evo.free_genes, weights=evo.weights, eval_seeds=evo.eval_seeds,
                           n_evaluations=budget, seed=evo.seed)
    print(f"  done in {time.perf_counter() - t0:.1f}s  evaluations {rs.evaluations}  "
          f"best {rs.final_best_fitness:+.4f}")

    al_config = active_learning_config_for_budget(budget, evo.eval_seeds, evo.free_genes,
                                                  weights=evo.weights, seed=evo.seed)
    print(f"Active learning (GP-EI): initial {al_config.n_initial}  iterations {al_config.n_iterations}  "
          f"budget-matched to {budget} simulator calls")
    t0 = time.perf_counter()
    al = run_active_learning_benchmark(base, al_config)
    print(f"  done in {time.perf_counter() - t0:.1f}s  evaluations {al.evaluations}  "
          f"best {al.final_best_fitness:+.4f}")

    print("-" * 78)
    print(f"{'method':<24}{'evaluations':>14}{'final_best_fitness':>22}{'runtime_s':>12}")
    for r in (ga, nsga2, rs, al):
        print(f"{r.method:<24}{r.evaluations:>14}{r.final_best_fitness:>22.4f}{r.runtime_seconds:>12.1f}")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / "benchmark_optimizers.json"
    payload = {
        "environment": environment_metadata(),
        "base_config": base.to_dict(),
        "budget_evaluations": budget,
        "results": {
            r.method: {
                "evaluations": r.evaluations, "final_best_fitness": r.final_best_fitness,
                "runtime_seconds": r.runtime_seconds, "best_genome": r.best_genome,
                "curve": [{"n_evaluations": p.n_evaluations, "best_fitness_so_far": p.best_fitness_so_far}
                         for p in r.curve],
            }
            for r in (ga, nsga2, rs, al)
        },
    }
    out.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")
    combined_frame([ga, nsga2, rs, al]).to_csv(REPORTS_DIR / "benchmark_optimizers.csv", index=False)
    print(f"Report written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
