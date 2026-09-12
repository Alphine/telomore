"""Exploratory sweep: does ANY caloric-restriction/intermittent-fasting-like
stress schedule beat the best constant-stress intervention, once maintenance
rate and repair rate are actually evolved to respond to it?

Context (docs/EXPERIMENT_PROTOCOL.md Experiment E): the existing
`configs/demo_fasting.yaml` alternates stress_level 0.90/0.30 (mean 0.60)
under a FIXED, un-evolved baseline intervention (maintenance=0.10,
repair=0.15) and was found to be slightly WORSE than constant stress. That
is not a fair test of "can fasting help" -- it never let the model's
intervention response adapt to the fasting rhythm. Experiment E separately
evolved a maintenance/repair SCHEDULE, but under constant stress, not
alternating stress. Nobody has evolved maintenance/repair (constant, or
phase-locked to the stress schedule) UNDER an alternating/intermittent
stress pattern. This script does that, sweeping amplitude and duty cycle,
each compared against the known best evolved-constant baseline
(TEL-20260910-001, +0.5234, docs/EXPERIMENT_PROTOCOL.md Experiment E).

Not registered in the experiment ledger (exploratory) -- promote a finding
to a real, documented Experiment only if this sweep turns up something.
"""

from __future__ import annotations

import json
import time

from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.schemas import EvolutionConfig, InterventionSchedule, ModelConfig

BASE = ModelConfig(
    initial_length=7500.0, initial_length_sd=800.0, population_size=100, carrying_capacity=400,
    telomeres_per_cell=32, shortening_rate=55.0, stress_sensitivity=100.0,
    maintenance_max_gain=120.0, senescence_threshold=3000.0, noise_sd=30.0,
    senescent_death_rate=0.03, cycles=120, seed=42,
)

EVO_KW = dict(
    population_size=32, generations=20, elite_fraction=0.10, mutation_rate=0.30,
    mutation_sigma=0.15, crossover_rate=0.70, crossover_kind="uniform", tournament_size=3,
    seed=7, eval_seeds=(1, 2, 3), free_genes=("maintenance_rate", "repair_rate"),
    early_stopping_patience=0, checkpoint_every=0,
)

# Each stress pattern: 6 equal 20-cycle phases, mean stress = 0.60 (matched
# to the constant-0.60 baseline so cost/burden is comparable), varying
# amplitude and duty cycle (how the high/low phases are arranged in time).
SCENARIOS = {
    "demo_pattern":   [0.90, 0.30, 0.90, 0.30, 0.90, 0.30],   # existing demo_fasting.yaml shape
    "mild":           [0.75, 0.45, 0.75, 0.45, 0.75, 0.45],   # smaller swing, same mean
    "extreme":        [1.00, 0.20, 1.00, 0.20, 1.00, 0.20],   # largest swing within bounds
    "short_fast":     [0.80, 0.80, 0.80, 0.80, 0.20, 0.20],   # long feeding, brief low-stress block (16:8-like)
    # NOTE (bug found and fixed during review): a first version of this used
    # [0.80, 0.20, 0.20, 0.80, 0.20, 0.20], which averages to 0.4, not the
    # 0.6 every other scenario is matched to -- its earlier fitness advantage
    # was confounded with simply having a lower mean stress, not a timing
    # effect. Corrected to the highest feasible high-phase value (1.00) that
    # still reaches the true 0.6 mean with a 2-high/4-low split.
    "long_fast":      [1.00, 0.40, 0.40, 1.00, 0.40, 0.40],   # brief feeding, long low-stress block (5:2-like)
}


def run_variant(name: str, stress_values, schedule_phases: int, n_workers: int = 4):
    schedule = InterventionSchedule(phases=6, values={"stress_level": tuple(stress_values)})
    base = BASE.replace(schedule=schedule, stress_level=stress_values[0]).validate()
    evo = EvolutionConfig(schedule_phases=schedule_phases, **EVO_KW).validate()
    t0 = time.perf_counter()
    result = EvolutionEngine(base, evo, n_workers=n_workers).run()
    dt = time.perf_counter() - t0
    tag = f"{name}_{'protocol' if schedule_phases > 1 else 'constant'}"
    print(f"{tag:28s} fitness={result.best.fitness:+.4f}  evals={result.evaluations:5d}  "
          f"time={dt:5.1f}s  genome={result.best.genome}")
    return tag, result.best.fitness, result.best.genome, result.evaluations


def main():
    print("Reference: constant stress 0.60, evolved constant intervention (Experiment E) = +0.5234\n")
    results = {}
    for name, values in SCENARIOS.items():
        for phases in (1, 6):
            tag, fitness, genome, evals = run_variant(name, values, phases)
            results[tag] = {"fitness": fitness, "genome": genome, "evaluations": evals}
    with open("experiments/reports/fasting_sweep.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2, default=float)
    print("\nwritten: experiments/reports/fasting_sweep.json")

    best_tag = max(results, key=lambda k: results[k]["fitness"])
    print(f"\nBest variant: {best_tag} = {results[best_tag]['fitness']:+.4f} "
          f"(vs. +0.5234 constant-stress control)")


if __name__ == "__main__":
    raise SystemExit(main())
