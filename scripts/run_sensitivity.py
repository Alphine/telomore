"""CLI: run one-at-a-time (OAT) sensitivity analysis headlessly.

    python scripts/run_sensitivity.py --config configs/sensitivity.yaml
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_sensitivity_config  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import run_sensitivity  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/sensitivity.yaml")
    ap.add_argument("--parameters", default=None, help="comma-separated, e.g. stress_level,repair_rate")
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    base, sens = load_sensitivity_config(args.config)
    if args.parameters:
        sens.parameters = tuple(p.strip() for p in args.parameters.split(","))
    sens.validate()

    def progress(item):
        if not args.quiet:
            print(f"{item.parameter:22s}  low {item.fitness_low:+.4f}  high {item.fitness_high:+.4f}  "
                  f"swing {item.swing:+.4f}")

    result, record = run_sensitivity(base, sens, ExperimentRegistry(), callback=progress,
                                     register=not args.no_register)

    print("-" * 78)
    print(f"baseline fitness : {result.baseline_fitness:+.4f}")
    print("Parameters by |swing| (fitness_high - fitness_low):")
    for _, row in result.to_frame().iterrows():
        print(f"  {row['parameter']:22s}  swing {row['swing']:+.4f}  "
              f"[{row['fitness_low']:+.4f}, {row['fitness_high']:+.4f}]")
    print(f"evaluations      : {result.evaluations}   runtime {result.runtime_seconds:.1f}s")
    if record:
        print(f"registered       : {record['run_id']}  -> {record['artifacts']['sensitivity_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
