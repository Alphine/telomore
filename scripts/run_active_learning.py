"""CLI: run surrogate-model (GP + Expected Improvement) active learning headlessly.

    python scripts/run_active_learning.py --config configs/active_learning.yaml --seed 1
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_active_learning_config  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import run_active_learning  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/active_learning.yaml")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    base, al = load_active_learning_config(args.config)
    if args.seed is not None:
        al.seed = args.seed
    al.validate()

    def progress(rec):
        if not args.quiet:
            print(f"[{rec.phase:7s}] iter {rec.iteration:3d}  real_fitness {rec.real_fitness:+.4f}  "
                  f"best_so_far {rec.best_so_far:+.4f}  evals {rec.n_real_evaluations}")

    result, record = run_active_learning(base, al, ExperimentRegistry(), callback=progress,
                                         register=not args.no_register)

    print("-" * 78)
    print(f"initial design   : {al.n_initial}   active iterations: {al.n_iterations}")
    print(f"best fitness     : {result.best_fitness:+.4f}")
    print(f"best genome      : {result.best_genome}")
    print(f"real evaluations : {result.evaluations}   runtime {result.runtime_seconds:.1f}s")
    if record:
        print(f"registered       : {record['run_id']} -> {record['artifacts']['active_learning_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
