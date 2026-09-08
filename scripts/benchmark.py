"""CLI: measure simulator and optimizer speed on this machine (SDD §5.1, §32).

    python scripts/benchmark.py
    python scripts/benchmark.py --evolution-population 100 --generations 3

Writes results to experiments/reports/benchmark.json.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import REPORTS_DIR  # noqa: E402
from telomere_lab.evolution.engine import EvolutionEngine  # noqa: E402
from telomere_lab.experiments.registry import environment_metadata  # noqa: E402
from telomere_lab.schemas import EvolutionConfig, ModelConfig  # noqa: E402
from telomere_lab.simulator.model import SimpleTelomereModel  # noqa: E402


def time_simulation(config: ModelConfig, repeats: int) -> dict:
    model = SimpleTelomereModel()
    times = []
    for i in range(repeats):
        t0 = time.perf_counter()
        res = model.simulate(config.replace(seed=config.seed + i))
        times.append(time.perf_counter() - t0)
        assert res.valid, res.failure_reason
    return {
        "config": {"population_size": config.population_size, "capacity": config.carrying_capacity,
                   "telomeres_per_cell": config.telomeres_per_cell, "cycles": config.cycles},
        "repeats": repeats,
        "mean_ms": statistics.mean(times) * 1000,
        "median_ms": statistics.median(times) * 1000,
        "max_ms": max(times) * 1000,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repeats", type=int, default=10)
    ap.add_argument("--evolution-population", type=int, default=32)
    ap.add_argument("--generations", type=int, default=3)
    args = ap.parse_args(argv)

    report = {"environment": environment_metadata(), "python_impl": platform.python_implementation()}

    default = ModelConfig()
    large = ModelConfig(population_size=200, carrying_capacity=1000, telomeres_per_cell=92, cycles=200)
    print("Single simulation (default config)...")
    report["simulation_default"] = time_simulation(default, args.repeats)
    print(f"  median {report['simulation_default']['median_ms']:.1f} ms  "
          f"(target < 1000 ms)  PASS={report['simulation_default']['median_ms'] < 1000}")
    print("Single simulation (large: 1000 cells x 92 telomeres x 200 cycles)...")
    report["simulation_large"] = time_simulation(large, max(3, args.repeats // 3))
    print(f"  median {report['simulation_large']['median_ms']:.1f} ms")

    evo = EvolutionConfig(population_size=args.evolution_population, generations=args.generations,
                          checkpoint_every=0)
    print(f"Evolution ({evo.population_size} candidates x {evo.generations} generations)...")
    t0 = time.perf_counter()
    result = EvolutionEngine(default, evo).run()
    elapsed = time.perf_counter() - t0
    report["evolution"] = {
        "population_size": evo.population_size,
        "generations": evo.generations,
        "evaluations": result.evaluations,
        "total_seconds": elapsed,
        "seconds_per_generation": elapsed / evo.generations,
        "ms_per_evaluation": elapsed / max(result.evaluations, 1) * 1000,
        "baseline_fitness": result.baseline.fitness,
        "best_fitness": result.best.fitness,
        "improved": result.best.fitness > result.baseline.fitness,
    }
    print(f"  {elapsed:.1f}s total, {report['evolution']['seconds_per_generation']:.2f}s/generation, "
          f"{report['evolution']['ms_per_evaluation']:.0f} ms/evaluation, "
          f"fitness {result.baseline.fitness:+.3f} -> {result.best.fitness:+.3f}")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / "benchmark.json"
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"Report written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
