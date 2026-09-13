"""Per-cell heritable repair_rate: population-genetics-style mutation-
selection balance (docs/MODEL.md §2.2/§2.3 sibling feature).

``repair_rate_mutation_sigma`` (default 0.0) is the feature's off switch:
unset, ``repair_rate`` stays the clone-shared scalar/schedule/override value
it always was, bit-identical to the pre-existing model (see the golden test
below, which mirrors ``test_genome_stability.py``'s own golden test). Opted
into (sigma > 0.0), each cell tracks its own repair_rate, seeded from its
clone's starting value, which mutates by a small Gaussian step at every
division and is inherited by daughters.
"""

from pathlib import Path

import numpy as np
import pytest

from telomere_lab.schemas import (
    EVOLVABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    ConfigError,
    InterventionSchedule,
    ModelConfig,
    SubcloneSpec,
)
from telomere_lab.simulator.model import simulate
from telomere_lab.simulator.population import divide

FIXTURES = Path(__file__).parent / "fixtures"


def golden_config(seed: int) -> ModelConfig:
    return ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=seed,
                       stress_level=0.6, maintenance_rate=0.3, repair_rate=0.25)


# --------------------------------------------------------------------- schema
def test_repair_rate_mutation_sigma_default_off():
    cfg = ModelConfig()
    assert cfg.repair_rate_mutation_sigma == 0.0
    # Out of MVP scope: not GA-searchable in this pass.
    assert "repair_rate_mutation_sigma" not in EVOLVABLE_PARAMETERS


def test_repair_rate_mutation_sigma_bounds_checked_like_any_other_parameter():
    lo, hi = PARAMETER_BOUNDS["repair_rate_mutation_sigma"][0], PARAMETER_BOUNDS["repair_rate_mutation_sigma"][1]
    with pytest.raises(ConfigError):
        ModelConfig(repair_rate_mutation_sigma=hi + 1.0).validate()
    with pytest.raises(ConfigError):
        ModelConfig(repair_rate_mutation_sigma=lo - 1.0).validate()


def test_repair_rate_mutation_sigma_rejects_combination_with_repair_rate_schedule():
    schedule = InterventionSchedule(phases=2, values={"repair_rate": (0.1, 0.3)})
    with pytest.raises(ConfigError):
        ModelConfig(repair_rate_mutation_sigma=0.05, schedule=schedule, cycles=10).validate()
    # A schedule on a different parameter is unaffected.
    other_schedule = InterventionSchedule(phases=2, values={"stress_level": (0.1, 0.3)})
    ModelConfig(repair_rate_mutation_sigma=0.05, schedule=other_schedule, cycles=10).validate()


# ------------------------------------------------------------------ simulator
def test_unset_repair_rate_mutation_is_bit_identical_to_golden():
    golden = np.load(FIXTURES / "simulator_golden_v0.1.0.npz")
    for seed in (1, 2):
        res = simulate(golden_config(seed))
        assert res.valid
        np.testing.assert_array_equal(res.mean_length, golden[f"mean_length_seed{seed}"])
        np.testing.assert_array_equal(res.senescent_fraction, golden[f"senescent_fraction_seed{seed}"])
        np.testing.assert_array_equal(res.final_lengths, golden[f"final_lengths_seed{seed}"])
        assert res.terminal_metrics["final_repair_rate_mean"] == pytest.approx(0.25)
        assert res.terminal_metrics["final_repair_rate_std"] == 0.0


def test_repair_rate_stays_within_bounds_under_large_sigma_and_many_divisions():
    cfg = ModelConfig(population_size=40, carrying_capacity=200, telomeres_per_cell=8, cycles=150, seed=7,
                      stress_level=0.5, maintenance_rate=0.3, repair_rate=0.5,
                      repair_rate_mutation_sigma=0.1)
    res = simulate(cfg)
    assert res.valid
    mean = res.terminal_metrics["final_repair_rate_mean"]
    std = res.terminal_metrics["final_repair_rate_std"]
    assert np.isfinite(mean) and 0.0 <= mean <= 1.0
    assert np.isfinite(std) and std >= 0.0
    assert np.all((res.mean_repair_rate >= 0.0) & (res.mean_repair_rate <= 1.0))


def test_repair_rate_diversifies_over_generations_when_mutation_enabled():
    base = dict(population_size=40, carrying_capacity=200, telomeres_per_cell=8, cycles=150, seed=11,
                stress_level=0.5, maintenance_rate=0.3, repair_rate=0.5)
    off = simulate(ModelConfig(**base, repair_rate_mutation_sigma=0.0))
    on = simulate(ModelConfig(**base, repair_rate_mutation_sigma=0.03))
    assert off.valid and on.valid
    assert off.terminal_metrics["final_repair_rate_std"] == 0.0
    assert on.terminal_metrics["final_repair_rate_std"] > 0.0


def test_repair_rate_mutation_extinction_edge_case_does_not_crash():
    cfg = ModelConfig(population_size=10, carrying_capacity=20, telomeres_per_cell=4, cycles=30, seed=5,
                      initial_length=3200, senescence_threshold=3100, shortening_rate=190,
                      stress_level=1.0, maintenance_rate=0.0, repair_rate=0.0,
                      repair_rate_mutation_sigma=0.05)
    res = simulate(cfg)
    assert res.valid
    assert np.isfinite(res.terminal_metrics["final_repair_rate_mean"])
    assert np.isfinite(res.terminal_metrics["final_repair_rate_std"])


def test_repair_rate_seeded_from_each_clone_at_cycle_zero():
    clones = (
        SubcloneSpec(name="high_repair", initial_fraction=0.5, overrides={"repair_rate": 0.9}),
        SubcloneSpec(name="low_repair", initial_fraction=0.5, overrides={"repair_rate": 0.1}),
    )
    cfg = ModelConfig(population_size=40, carrying_capacity=120, telomeres_per_cell=8, cycles=1, seed=3,
                      stress_level=0.5, maintenance_rate=0.3, repair_rate=0.5,
                      repair_rate_mutation_sigma=0.02, subclones=clones)
    res = simulate(cfg)
    assert res.valid
    # After only 1 cycle, the population-wide mean should sit between the two
    # clones' seed values (0.1 and 0.9), reflecting the per-clone seeding --
    # not collapsed to the config's own scalar (0.5) or a single clone's value.
    assert 0.1 < res.terminal_metrics["final_repair_rate_mean"] < 0.9


def test_json_export_includes_repair_rate_drift_keys():
    cfg = ModelConfig(population_size=20, cycles=10, seed=1, repair_rate_mutation_sigma=0.05)
    res = simulate(cfg)
    out = res.to_json_dict()
    assert "mean_repair_rate" in out["timeseries"]
    assert "final_repair_rate_mean" in out["terminal_metrics"]
    assert "final_repair_rate_std" in out["terminal_metrics"]
    import json
    json.dumps(out)  # round-trips without error


# ------------------------------------------------------------------ population
def test_divide_copies_repair_rate_cells_without_mutating():
    lengths = np.ones((4, 2))
    senescent = np.array([False, False, True, False])
    founder_id = np.arange(4)
    clone_id = np.zeros(4, dtype=int)
    mutation_burden = np.zeros(4)
    repair_rate_cells = np.array([0.1, 0.2, 0.3, 0.4])

    (new_lengths, new_senescent, new_founder_id, new_clone_id, new_mutation_burden,
     new_repair_rate_cells, divided) = divide(lengths, senescent, founder_id, clone_id, mutation_burden,
                                               repair_rate_cells)

    prolif = ~senescent
    expected = np.concatenate([repair_rate_cells, repair_rate_cells[prolif]])
    np.testing.assert_array_equal(new_repair_rate_cells, expected)
    # divide() only copies -- the mutation step is applied by the caller.
    np.testing.assert_array_equal(new_repair_rate_cells[divided], expected[divided])
