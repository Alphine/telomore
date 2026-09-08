"""CLI: run the NSGA-II multi-objective optimizer headlessly.

    python scripts/run_pareto.py --config configs/pareto.yaml --seed 7
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_multiobjective_config  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import run_pareto  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/pareto.yaml")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--generations", type=int, default=None)
    ap.add_argument("--population", type=int, default=None)
    ap.add_argument("--objectives", default=None, help="comma-separated, e.g. survival,cost,senescence")
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    base, mo = load_multiobjective_config(args.config)
    if args.seed is not None:
        mo.seed = args.seed
    if args.generations is not None:
        mo.generations = args.generations
    if args.population is not None:
        mo.population_size = args.population
    if args.objectives:
        mo.objectives = tuple(o.strip() for o in args.objectives.split(","))
    mo.validate()

    def progress(rec):
        if not args.quiet:
            best = "  ".join(f"{k}={v:.3f}" for k, v in rec.objective_best.items())
            print(f"gen {rec.generation:3d}  front {rec.front_size:3d}  HV {rec.hypervolume:.4f}  | best {best}")

    result, record = run_pareto(base, mo, ExperimentRegistry(), callback=progress,
                                register=not args.no_register)

    print("-" * 78)
    print(f"objectives   : {list(mo.objectives)}")
    print(f"front size   : {len(result.front)}   hypervolume {result.history[-1].hypervolume:.4f}")
    print(f"baseline     : {result.baseline.objectives}  scalar {result.baseline.scalar_fitness:+.4f}")
    print("Pareto front (sorted by first objective):")
    for c in sorted(result.front, key=lambda c: c.vector[0]):
        objs = "  ".join(f"{k}={v:.3f}" for k, v in c.objectives.items())
        genes = "  ".join(f"{k}={v:.3f}" for k, v in c.genome.items())
        print(f"  {objs}  | {genes}  | scalar {c.scalar_fitness:+.3f}")
    print(f"evaluations  : {result.evaluations}   runtime {result.runtime_seconds:.1f}s")
    if record:
        print(f"registered   : {record['run_id']}  -> {record['artifacts']['pareto_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
