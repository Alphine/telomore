"""CLI: run the evolutionary optimizer headlessly.

    python scripts/run_evolution.py --config configs/evolution.yaml --seed 7
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_evolution_config  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import run_evolution  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/evolution.yaml")
    ap.add_argument("--seed", type=int, default=None, help="override optimizer seed")
    ap.add_argument("--generations", type=int, default=None)
    ap.add_argument("--population", type=int, default=None)
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    base, evo = load_evolution_config(args.config)
    if args.seed is not None:
        evo.seed = args.seed
    if args.generations is not None:
        evo.generations = args.generations
    if args.population is not None:
        evo.population_size = args.population
    evo.validate()

    def progress(rec):
        if not args.quiet:
            genes = "  ".join(f"{k}={v:.3f}" for k, v in rec.best_genome.items())
            print(f"gen {rec.generation:3d}  best {rec.best_fitness:+.4f}  "
                  f"mean {rec.mean_fitness:+.4f}  div {rec.diversity:.3f}  | {genes}")

    result, record = run_evolution(base, evo, ExperimentRegistry(), callback=progress,
                                   register=not args.no_register)

    print("-" * 72)
    print(f"baseline fitness : {result.baseline.fitness:+.4f}")
    print(f"best fitness     : {result.best.fitness:+.4f}")
    print(f"improvement      : {result.best.fitness - result.baseline.fitness:+.4f}")
    print(f"best genome      : {result.best.genome}")
    print(f"evaluations      : {result.evaluations}   runtime {result.runtime_seconds:.1f}s")
    if result.stopped_early:
        print(f"stopped early    : {result.stop_reason}")
    if record:
        print(f"registered       : {record['run_id']}  -> {record['artifacts']['evolution_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
