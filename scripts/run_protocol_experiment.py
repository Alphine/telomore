"""CLI: Experiment E — constant interventions vs. a 6-phase scheduled protocol.

Runs the two GA configs with the same optimizer seed (both are registered in
the ledger like any other evolution run), then simulates the baseline, the
best constant candidate, the best protocol candidate and the hand-written
fasting-like demo protocol on a common set of simulator seeds, and writes
the comparison to ``experiments/reports/experiment_e.json``.

    python scripts/run_protocol_experiment.py --seed 7
    python scripts/run_protocol_experiment.py --seed 7 --no-register   # dry run, nothing in the ledger
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np  # noqa: E402

from telomere_lab.config import REPORTS_DIR, load_evolution_config, load_model_config  # noqa: E402
from telomere_lab.evolution.fitness import compute_fitness  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry, _json_default, environment_metadata  # noqa: E402
from telomere_lab.experiments.runner import run_evolution  # noqa: E402
from telomere_lab.schemas import ModelConfig  # noqa: E402
from telomere_lab.simulator.model import simulate  # noqa: E402


def evaluate(config: ModelConfig, weights, seeds) -> Dict[str, object]:
    """Fitness breakdown + terminal metrics averaged over ``seeds`` (mean and SD of fitness)."""
    fits: List[float] = []
    rows: List[Dict[str, float]] = []
    bd = None
    for s in seeds:
        res = simulate(config.replace(seed=int(s)))
        bd = compute_fitness(res, weights)
        fits.append(bd.total)
        rows.append({**res.terminal_metrics, "survival": bd.survival, "reserve": bd.reserve,
                     "senescence": bd.senescence, "instability": bd.instability, "cost": bd.cost})
    means = {k: float(np.mean([r[k] for r in rows])) for k in rows[0]
             if isinstance(rows[0][k], (int, float)) and not isinstance(rows[0][k], bool)}
    return {
        "config": config.to_dict(),
        "mean_maintenance": config.mean_value("maintenance_rate"),
        "mean_repair": config.mean_value("repair_rate"),
        "mean_stress": config.mean_value("stress_level"),
        "fitness_mean": float(np.mean(fits)),
        "fitness_sd": float(np.std(fits)),
        "fitness_per_seed": {int(s): f for s, f in zip(seeds, fits)},
        "metrics_mean": means,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--constant", default="configs/evolution_locked.yaml")
    ap.add_argument("--protocol", default="configs/evolution_protocol.yaml")
    ap.add_argument("--demo", default="configs/demo_fasting.yaml")
    ap.add_argument("--seed", type=int, default=7, help="optimizer seed for both GA runs")
    ap.add_argument("--eval-seeds", default="1,2,3,4,5", help="simulator seeds for the comparison table")
    ap.add_argument("--out", default=str(REPORTS_DIR / "experiment_e.json"))
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    eval_seeds = [int(s) for s in args.eval_seeds.split(",")]

    def progress(label):
        def cb(rec):
            if not args.quiet:
                print(f"[{label}] gen {rec.generation:3d}  best {rec.best_fitness:+.4f}  "
                      f"mean {rec.mean_fitness:+.4f}  div {rec.diversity:.3f}")
        return cb

    registry = ExperimentRegistry()
    report: Dict[str, object] = {"environment": environment_metadata(), "optimizer_seed": args.seed,
                                 "eval_seeds": eval_seeds, "runs": {}, "scenarios": {}}

    base_constant, evo_constant = load_evolution_config(args.constant)
    base_protocol, evo_protocol = load_evolution_config(args.protocol)
    evo_constant.seed = evo_protocol.seed = args.seed
    assert base_constant == base_protocol, "the two GA configs must share the same base model"
    weights = evo_constant.weights

    results = {}
    for label, base, evo in (("constant", base_constant, evo_constant), ("protocol", base_protocol, evo_protocol)):
        print(f"== GA {label}: free genes {list(evo.free_genes)}  schedule_phases {evo.schedule_phases}")
        result, record = run_evolution(base, evo, registry, callback=progress(label),
                                       register=not args.no_register, notes=f"Experiment E ({label})")
        results[label] = result
        report["runs"][label] = {
            "run_id": record["run_id"] if record else None,
            "config_file": args.constant if label == "constant" else args.protocol,
            "schedule_phases": evo.schedule_phases,
            "best_fitness": result.best.fitness,
            "baseline_fitness": result.baseline.fitness,
            "best_genome": result.best.genome,
            "best_breakdown": result.best.breakdown.to_dict() if result.best.breakdown else None,
            "history_best": [h.best_fitness for h in result.history],
            "final_diversity": result.history[-1].diversity,
            "evaluations": result.evaluations,
            "runtime_seconds": result.runtime_seconds,
        }
        print(f"   best {result.best.fitness:+.4f}  baseline {result.baseline.fitness:+.4f}  "
              f"evaluations {result.evaluations}  {result.runtime_seconds:.1f}s")
        if record:
            print(f"   registered {record['run_id']}")

    scenarios = {
        "baseline": base_constant,
        "evolved_constant": results["constant"].best_config(),
        "evolved_protocol": results["protocol"].best_config(),
        "fasting_demo": load_model_config(args.demo),
    }
    # A constant control with the protocol's *time-averaged* doses: isolates the value of
    # the timing itself from the value of the mean dose.
    proto = scenarios["evolved_protocol"]
    scenarios["constant_at_protocol_mean"] = base_constant.replace(
        maintenance_rate=proto.mean_value("maintenance_rate"), repair_rate=proto.mean_value("repair_rate"))

    print(f"== Scenarios on simulator seeds {eval_seeds}")
    for name, cfg in scenarios.items():
        row = evaluate(cfg, weights, eval_seeds)
        report["scenarios"][name] = row
        m = row["metrics_mean"]
        print(f"   {name:26s} fitness {row['fitness_mean']:+.4f} ± {row['fitness_sd']:.4f}  "
              f"maint {row['mean_maintenance']:.3f}  repair {row['mean_repair']:.3f}  "
              f"cost {m['cost']:.3f}  survival {m['normalized_survival']:.3f}  "
              f"senescent {m['final_senescent_fraction']:.3f}  reserve {m['normalized_telomere_reserve']:.3f}")

    if proto.schedule is not None:
        print("== Evolved protocol phases")
        for k in range(proto.schedule.phases):
            vals = "  ".join(f"{n}={proto.schedule.values[n][k]:.3f}" for n in sorted(proto.schedule.values))
            print(f"   phase {k}: {vals}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, default=_json_default), encoding="utf-8")
    print(f"report written : {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
