"""CLI: run one telomere simulation headlessly.

    python scripts/run_simulation.py --config configs/demo.yaml --seed 42
    python scripts/run_simulation.py --set stress_level=0.8 --set maintenance_rate=0.5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_model_config  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import record_simulation, run_simulation, score  # noqa: E402
from telomere_lab.schemas import FitnessWeights  # noqa: E402


def parse_overrides(items):
    out = {}
    for item in items or []:
        key, _, value = item.partition("=")
        if not _:
            raise SystemExit(f"--set expects key=value, got {item!r}")
        try:
            out[key] = float(value) if "." in value or "e" in value.lower() else int(value)
        except ValueError:
            out[key] = value
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None, help="YAML with a `model:` block (default: built-in defaults)")
    ap.add_argument("--seed", type=int, default=None, help="override the random seed")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE", help="override any ModelConfig field")
    ap.add_argument("--no-register", action="store_true", help="do not write to the experiment registry")
    ap.add_argument("--json", action="store_true", help="print full result JSON to stdout")
    ap.add_argument("--out", default=None, help="write result JSON to this path")
    args = ap.parse_args(argv)

    config = load_model_config(args.config)
    overrides = parse_overrides(args.set)
    if args.seed is not None:
        overrides["seed"] = args.seed
    if overrides:
        config = config.replace(**overrides).validate()

    result = run_simulation(config, use_cache=False)
    bd = score(result, FitnessWeights())

    if not result.valid:
        print(f"SIMULATION FAILED: {result.failure_reason}", file=sys.stderr)
        return 2

    tm = result.terminal_metrics
    print(f"model_version      : {result.model_version}")
    print(f"seed               : {result.seed}")
    print(f"config_hash        : {result.config.config_hash()}")
    print(f"runtime            : {result.runtime_seconds*1000:.1f} ms")
    print(f"final mean length  : {tm['final_mean_length_bp']/1000:.2f} kb")
    print(f"final shortest/cell: {tm['final_mean_shortest_bp']/1000:.2f} kb")
    print(f"senescent fraction : {tm['final_senescent_fraction']:.3f}")
    print(f"t(50% senescent)   : {tm['time_to_50pct_senescence']}")
    print(f"final population   : {tm['final_population_size']}")
    print(f"fitness (default w): {bd.total:.4f}  "
          f"[survival {bd.survival:.3f} reserve {bd.reserve:.3f} "
          f"senescence {bd.senescence:.3f} instability {bd.instability:.3f} cost {bd.cost:.3f}]")

    if not args.no_register:
        rec = record_simulation(result, ExperimentRegistry())
        print(f"registered         : {rec['run_id']}  ({rec['artifacts']['result_json']})")

    if args.out:
        Path(args.out).write_text(json.dumps(result.to_json_dict(), indent=2, default=float), encoding="utf-8")
        print(f"written            : {args.out}")
    if args.json:
        print(json.dumps(result.to_json_dict(include_final_lengths=False), indent=2, default=float))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
