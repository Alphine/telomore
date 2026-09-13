"""Genome stability: mutation burden and apoptosis checkpoint (docs/MODEL.md
§2.3, "Genome Stability Lab" candidate feature).

The golden fixture in ``tests/fixtures/`` was produced by the code before
genome stability existed (see ``tests/test_schedule.py``'s own docstring), so
the bit-identity test below proves an unset config still runs the exact same
model.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from telomere_lab.evolution.fitness import compute_fitness
from telomere_lab.schemas import (
    EVOLVABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    ConfigError,
    FitnessWeights,
    ModelConfig,
)
from telomere_lab.simulator.model import simulate
from telomere_lab.simulator.population import remove_apoptotic

FIXTURES = Path(__file__).parent / "fixtures"

GENOME_STABILITY_PARAMETERS = (
    "replication_error_rate",
    "oxidative_mutation_sensitivity",
    "checkpoint_strength",
    "mutation_threshold",
)


def golden_config(seed: int) -> ModelConfig:
    return ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=seed,
                       stress_level=0.6, maintenance_rate=0.3, repair_rate=0.25)


def small(**kw) -> ModelConfig:
    base = dict(population_size=40, carrying_capacity=80, telomeres_per_cell=8, cycles=60, seed=3,
                stress_level=0.6, maintenance_rate=0.0, repair_rate=0.0)
    base.update(kw)
    return ModelConfig(**base)


# --------------------------------------------------------------------- schema
def test_genome_stability_fields_default_off():
    cfg = ModelConfig()
    assert cfg.replication_error_rate == 0.0
    assert cfg.oxidative_mutation_sensitivity == 0.0
    assert cfg.checkpoint_strength == 0.0
    assert cfg.mutation_threshold == pytest.approx(1.0e9)
    assert set(GENOME_STABILITY_PARAMETERS) <= set(EVOLVABLE_PARAMETERS)


def test_genome_stability_bounds_checked_like_any_other_parameter():
    for key in GENOME_STABILITY_PARAMETERS:
        lo, hi = PARAMETER_BOUNDS[key][0], PARAMETER_BOUNDS[key][1]
        with pytest.raises(ConfigError):
            ModelConfig(**{key: hi + 1.0}).validate()
        with pytest.raises(ConfigError):
            ModelConfig(**{key: lo - 1.0}).validate()


def test_genome_stability_roundtrip_and_backward_compatible_from_dict():
    cfg = ModelConfig(replication_error_rate=0.01, oxidative_mutation_sensitivity=0.02,
                      checkpoint_strength=0.5, mutation_threshold=2.0)
    d = cfg.to_dict()
    again = ModelConfig.from_dict(json.loads(json.dumps(d)))
    assert again == cfg

    # a config dict from before genome stability existed still loads with
    # every new field at its default.
    old = {k: v for k, v in ModelConfig().to_dict().items() if k not in GENOME_STABILITY_PARAMETERS}
    legacy = ModelConfig.from_dict(old)
    assert legacy == ModelConfig()


def test_config_hash_includes_genome_stability_but_unset_hash_is_unchanged():
    plain = ModelConfig(cycles=50)
    active = plain.replace(checkpoint_strength=0.5, mutation_threshold=2.0)
    assert plain.config_hash() != active.config_hash()

    all_default_keys = plain.replace(
        replication_error_rate=0.0, oxidative_mutation_sensitivity=0.0,
        checkpoint_strength=0.0, mutation_threshold=1.0e9,
    )
    assert plain.config_hash() == all_default_keys.config_hash()


# ------------------------------------------------------------------ simulator
def test_unset_genome_stability_is_bit_identical_to_pre_genome_stability_golden():
    golden = np.load(FIXTURES / "simulator_golden_v0.1.0.npz")
    for seed in (1, 2):
        res = simulate(golden_config(seed))
        assert res.valid
        np.testing.assert_array_equal(res.mean_length, golden[f"mean_length_seed{seed}"])
        np.testing.assert_array_equal(res.senescent_fraction, golden[f"senescent_fraction_seed{seed}"])
        np.testing.assert_array_equal(res.final_lengths, golden[f"final_lengths_seed{seed}"])
        np.testing.assert_array_equal(res.mean_mutation_burden, np.zeros_like(res.mean_mutation_burden))
        np.testing.assert_array_equal(res.apoptotic_fraction, np.zeros_like(res.apoptotic_fraction))
        assert res.terminal_metrics["final_mutation_burden"] == 0.0
        assert res.terminal_metrics["genomic_instability_index"] == 0.0


def test_mutation_burden_grows_with_replication_error_and_oxidative_sensitivity():
    cfg = small(replication_error_rate=0.01, oxidative_mutation_sensitivity=0.02, stress_level=0.5)
    res = simulate(cfg)
    assert res.valid
    alive = res.population_size > 0
    # Every division adds a non-negative increment, but passaging randomly
    # subsamples cells (docs/MODEL.md), so the *mean* over survivors need not
    # be strictly monotone -- only nonzero and clearly above the starting 0.0.
    assert res.mean_mutation_burden[alive][0] == 0.0
    assert res.mean_mutation_burden[alive][-1] > 0.0


def test_higher_checkpoint_strength_lowers_instability_but_also_population():
    """A stronger apoptosis checkpoint should clear out high-burden cells more
    aggressively: lower genomic_instability_index, but at the cost of a
    smaller final population (docs/MODEL.md §2.3)."""
    base = dict(population_size=60, carrying_capacity=120, telomeres_per_cell=8, cycles=80, seed=11,
                stress_level=0.6, maintenance_rate=0.0, repair_rate=0.0,
                replication_error_rate=0.02, oxidative_mutation_sensitivity=0.02,
                mutation_threshold=0.5)
    weak = simulate(ModelConfig(**base, checkpoint_strength=0.05))
    strong = simulate(ModelConfig(**base, checkpoint_strength=0.6))
    assert weak.valid and strong.valid
    assert strong.terminal_metrics["genomic_instability_index"] <= weak.terminal_metrics["genomic_instability_index"]
    assert strong.terminal_metrics["final_population_size"] <= weak.terminal_metrics["final_population_size"]


def test_extinction_edge_case_handles_empty_population_without_div_by_zero():
    cfg = ModelConfig(population_size=10, carrying_capacity=20, telomeres_per_cell=4, cycles=30, seed=1,
                      stress_level=1.0, stress_sensitivity=300.0, shortening_rate=200.0,
                      senescent_death_rate=0.5, senescence_threshold=5900, initial_length=6000,
                      replication_error_rate=0.02, oxidative_mutation_sensitivity=0.02,
                      checkpoint_strength=0.3, mutation_threshold=0.1)
    res = simulate(cfg)
    assert res.valid
    # mean_mutation_burden/apoptotic_fraction go nan once the population is
    # extinct, exactly like mean_length/senescent_fraction do -- terminal
    # metrics (computed from the final live-array, not the nan timeseries)
    # must still be finite.
    alive = res.population_size > 0
    assert np.all(np.isfinite(res.mean_mutation_burden[alive]))
    assert np.all(np.isfinite(res.apoptotic_fraction[alive]))
    assert np.isfinite(res.terminal_metrics["final_mutation_burden"])
    assert np.isfinite(res.terminal_metrics["genomic_instability_index"])
    if res.terminal_metrics["extinct"]:
        assert res.terminal_metrics["final_mutation_burden"] == 0.0
        assert res.terminal_metrics["genomic_instability_index"] == 0.0


def test_json_export_includes_genome_stability_keys():
    cfg = small(replication_error_rate=0.01, checkpoint_strength=0.2, mutation_threshold=1.0)
    res = simulate(cfg)
    payload = json.loads(json.dumps(res.to_json_dict(include_final_lengths=False), default=float))
    assert "mean_mutation_burden" in payload["timeseries"]
    assert "apoptotic_fraction" in payload["timeseries"]
    assert len(payload["timeseries"]["mean_mutation_burden"]) == len(payload["timeseries"]["cycle"])
    assert "final_mutation_burden" in payload["terminal_metrics"]
    assert "genomic_instability_index" in payload["terminal_metrics"]


# --------------------------------------------------------------------- fitness
def test_fitness_genome_instability_term_is_inert_at_default_weight():
    cfg = small(replication_error_rate=0.02, oxidative_mutation_sensitivity=0.02,
               checkpoint_strength=0.3, mutation_threshold=0.5)
    res = simulate(cfg)
    default_weights = FitnessWeights()
    assert default_weights.w_genome_instability == 0.0
    bd = compute_fitness(res, default_weights)
    assert bd.genome_instability == pytest.approx(res.terminal_metrics["genomic_instability_index"])
    # weight is 0.0, so the instability term contributes nothing to total
    zero_weight_bd = compute_fitness(res, FitnessWeights(w_genome_instability=0.0))
    assert bd.total == pytest.approx(zero_weight_bd.total)

    nonzero_weight_bd = compute_fitness(res, FitnessWeights(w_genome_instability=1.0))
    if bd.genome_instability > 0:
        assert nonzero_weight_bd.total < bd.total


# ------------------------------------------------------------------ population
def test_remove_apoptotic_is_noop_when_checkpoint_strength_is_zero():
    rng = np.random.default_rng(0)
    lengths = np.ones((5, 2))
    senescent = np.zeros(5, dtype=bool)
    founder_id = np.arange(5)
    clone_id = np.zeros(5, dtype=int)
    mutation_burden = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    repair_rate_cells = np.full(5, 0.2)
    apoptotic = mutation_burden > 1.5
    out = remove_apoptotic(rng, lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells,
                            apoptotic, 0.0)
    assert out[0].shape[0] == 5
    np.testing.assert_array_equal(out[4], mutation_burden)


def test_remove_apoptotic_removes_flagged_cells_with_seeded_rng():
    rng = np.random.default_rng(0)
    lengths = np.ones((5, 2))
    senescent = np.zeros(5, dtype=bool)
    founder_id = np.arange(5)
    clone_id = np.zeros(5, dtype=int)
    mutation_burden = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    repair_rate_cells = np.full(5, 0.2)
    apoptotic = mutation_burden > 1.5
    lengths2, senescent2, founder2, clone2, burden2, repair2, apop2 = remove_apoptotic(
        rng, lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells, apoptotic, 1.0
    )
    # checkpoint_strength=1.0 removes every apoptotic cell deterministically
    assert lengths2.shape[0] == 2
    np.testing.assert_array_equal(burden2, mutation_burden[~apoptotic])
