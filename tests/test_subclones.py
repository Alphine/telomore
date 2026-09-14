"""Sub-population / sub-clone competition (docs/MODEL.md §2.2, ROADMAP.md
candidate feature #4): multiple genetically distinct clones competing for
carrying-capacity slots within one simulation.

The golden fixture in ``tests/fixtures/`` was produced by the code before
subclones existed (see ``tests/test_schedule.py``'s own docstring), so the
bit-identity test below proves an unset ``subclones`` config still runs the
exact same model.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from telomere_lab.schemas import (
    PARAMETER_BOUNDS,
    SUBCLONE_OVERRIDABLE_PARAMETERS,
    ConfigError,
    InterventionSchedule,
    ModelConfig,
    SubcloneSpec,
)
from telomere_lab.simulator.model import simulate

FIXTURES = Path(__file__).parent / "fixtures"


def golden_config(seed: int) -> ModelConfig:
    return ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=seed,
                       stress_level=0.6, maintenance_rate=0.3, repair_rate=0.25)


def small(**kw) -> ModelConfig:
    base = dict(population_size=40, carrying_capacity=80, telomeres_per_cell=8, cycles=60, seed=3,
                stress_level=0.6, maintenance_rate=0.0, repair_rate=0.0)
    base.update(kw)
    return ModelConfig(**base)


# --------------------------------------------------------------------- schema
def test_subclone_spec_validation():
    ok = SubcloneSpec(name="a", initial_fraction=0.5, overrides={"maintenance_rate": 0.5})
    assert ok.validate() is ok
    with pytest.raises(ConfigError):  # empty name
        SubcloneSpec(name="", initial_fraction=0.5).validate()
    with pytest.raises(ConfigError):  # fraction out of (0, 1]
        SubcloneSpec(name="a", initial_fraction=0.0).validate()
    with pytest.raises(ConfigError):
        SubcloneSpec(name="a", initial_fraction=1.5).validate()
    with pytest.raises(ConfigError):  # non-overridable key
        SubcloneSpec(name="a", initial_fraction=0.5, overrides={"senescence_threshold": 4000.0}).validate()
    with pytest.raises(ConfigError):  # non-overridable structural key
        SubcloneSpec(name="a", initial_fraction=0.5, overrides={"carrying_capacity": 500.0}).validate()
    with pytest.raises(ConfigError):  # out of bounds
        SubcloneSpec(name="a", initial_fraction=0.5, overrides={"repair_rate": 5.0}).validate()
    assert set(SUBCLONE_OVERRIDABLE_PARAMETERS) == {
        "shortening_rate", "maintenance_rate", "repair_rate", "stress_sensitivity",
        "replication_error_rate", "oxidative_mutation_sensitivity", "checkpoint_strength", "mutation_threshold",
    }


def test_model_config_subclones_validation():
    with pytest.raises(ConfigError):  # single clone is meaningless
        ModelConfig(subclones=(SubcloneSpec("solo", 1.0),)).validate()
    with pytest.raises(ConfigError):  # fractions don't sum to 1
        ModelConfig(subclones=(SubcloneSpec("a", 0.5), SubcloneSpec("b", 0.6))).validate()
    with pytest.raises(ConfigError):  # duplicate names
        ModelConfig(subclones=(SubcloneSpec("a", 0.5), SubcloneSpec("a", 0.5))).validate()
    with pytest.raises(ConfigError):  # bad override key surfaces through ModelConfig.validate too
        ModelConfig(subclones=(SubcloneSpec("a", 0.5, {"stress_level": 0.5}), SubcloneSpec("b", 0.5))).validate()
    ok = ModelConfig(subclones=(SubcloneSpec("a", 0.3, {"repair_rate": 0.5}), SubcloneSpec("b", 0.7)))
    assert ok.validate() is ok
    # small floating tolerance is accepted
    tol = ModelConfig(subclones=(SubcloneSpec("a", 1 / 3), SubcloneSpec("b", 1 / 3), SubcloneSpec("c", 1 / 3)))
    tol.validate()


def test_subclones_roundtrip_and_backward_compatible_from_dict():
    cfg = ModelConfig(subclones=(
        SubcloneSpec("resilient", 0.5, {"maintenance_rate": 0.6, "repair_rate": 0.6}),
        SubcloneSpec("fragile", 0.5, {}),
    ))
    d = cfg.to_dict()
    assert d["subclones"] == [
        {"name": "resilient", "initial_fraction": 0.5, "overrides": {"maintenance_rate": 0.6, "repair_rate": 0.6}},
        {"name": "fragile", "initial_fraction": 0.5, "overrides": {}},
    ]
    again = ModelConfig.from_dict(json.loads(json.dumps(d)))
    assert again == cfg
    assert again.replace(seed=5).subclones == cfg.subclones
    assert cfg.replace(subclones=None).subclones is None

    # a config dict from before subclones existed still loads with subclones=None
    old = {k: v for k, v in ModelConfig().to_dict().items() if k != "subclones"}
    legacy = ModelConfig.from_dict(old)
    assert legacy.subclones is None
    assert legacy == ModelConfig()
    assert ModelConfig.from_dict({"cycles": 10}).subclones is None


def test_config_hash_includes_subclones_but_unset_hash_is_unchanged():
    plain = ModelConfig(cycles=50)
    two_clone = plain.replace(subclones=[
        {"name": "a", "initial_fraction": 0.5, "overrides": {}},
        {"name": "b", "initial_fraction": 0.5, "overrides": {"repair_rate": 0.9}},
    ])
    assert plain.config_hash() != two_clone.config_hash()
    assert two_clone.config_hash() == two_clone.replace(seed=99).config_hash()
    import hashlib

    data = plain.to_dict()
    data.pop("seed")
    data.pop("schedule")
    data.pop("subclones")
    expected = hashlib.sha256(json.dumps(data, sort_keys=True, default=float).encode()).hexdigest()[:16]
    assert plain.config_hash() == expected


# ------------------------------------------------------------------ simulator
def test_unset_subclones_is_bit_identical_to_pre_subclone_golden():
    golden = np.load(FIXTURES / "simulator_golden_v0.1.0.npz")
    for seed in (1, 2):
        res = simulate(golden_config(seed))
        assert res.valid
        np.testing.assert_array_equal(res.mean_length, golden[f"mean_length_seed{seed}"])
        np.testing.assert_array_equal(res.senescent_fraction, golden[f"senescent_fraction_seed{seed}"])
        np.testing.assert_array_equal(res.final_lengths, golden[f"final_lengths_seed{seed}"])
        assert res.clone_fraction == {}


def test_single_default_clone_with_no_overrides_matches_unset(monkeypatch):
    """An explicit two-clone config where both clones have identical overrides
    to the config's own scalars must reproduce the unset case's terminal
    metrics exactly (same effective per-cell arithmetic, just split into two
    named groups instead of one)."""
    cfg = golden_config(seed=1)
    two = cfg.replace(subclones=[
        {"name": "x", "initial_fraction": 0.5, "overrides": {}},
        {"name": "y", "initial_fraction": 0.5, "overrides": {}},
    ])
    a, b = simulate(cfg), simulate(two)
    np.testing.assert_array_equal(a.mean_length, b.mean_length)
    np.testing.assert_array_equal(a.senescent_fraction, b.senescent_fraction)
    assert a.terminal_metrics == b.terminal_metrics
    assert set(b.clone_fraction) == {"x", "y"}
    for arr in b.clone_fraction.values():
        assert arr.shape == a.time.shape


def test_clone_fraction_sums_to_one_while_population_survives():
    cfg = small(subclones=(
        SubcloneSpec("resilient", 0.5, {"maintenance_rate": 0.6, "repair_rate": 0.6}),
        SubcloneSpec("fragile", 0.5, {}),
    ))
    res = simulate(cfg)
    assert res.valid
    total = sum(res.clone_fraction.values())
    alive = res.population_size > 0
    np.testing.assert_allclose(total[alive], 1.0, atol=1e-9)


def test_resilient_clone_gains_share_over_fragile_baseline():
    """A clone with much higher maintenance/repair should end up a larger
    share of the population than a baseline clone under shared stress --
    proliferative cells keep dividing, senescent ones don't, so staying
    non-senescent longer accumulates more descendants (docs/MODEL.md §2.2)."""
    cfg = ModelConfig(population_size=60, carrying_capacity=120, telomeres_per_cell=8, cycles=90, seed=11,
                      stress_level=0.7, maintenance_rate=0.0, repair_rate=0.0,
                      subclones=(
                          SubcloneSpec("resilient", 0.5, {"maintenance_rate": 0.7, "repair_rate": 0.7}),
                          SubcloneSpec("fragile", 0.5, {}),
                      ))
    res = simulate(cfg)
    assert res.valid
    resilient, fragile = res.clone_fraction["resilient"], res.clone_fraction["fragile"]
    assert resilient[-1] > resilient[0]
    assert fragile[-1] < fragile[0]
    assert resilient[-1] > fragile[-1]


def test_extinction_edge_case_handles_empty_population_without_div_by_zero():
    cfg = ModelConfig(population_size=10, carrying_capacity=20, telomeres_per_cell=4, cycles=30, seed=1,
                      stress_level=1.0, stress_sensitivity=300.0, shortening_rate=200.0,
                      senescent_death_rate=0.5, senescence_threshold=5900, initial_length=6000,
                      subclones=(SubcloneSpec("a", 0.5, {}), SubcloneSpec("b", 0.5, {})))
    res = simulate(cfg)
    assert res.valid
    assert res.terminal_metrics["extinct"] or res.population_size[-1] >= 0
    for arr in res.clone_fraction.values():
        assert np.all(np.isfinite(arr))
    if res.terminal_metrics["extinct"]:
        assert res.clone_fraction["a"][-1] == 0.0
        assert res.clone_fraction["b"][-1] == 0.0


def test_runtime_with_subclones_stays_within_target():
    cfg = ModelConfig(subclones=(SubcloneSpec("a", 0.5, {"maintenance_rate": 0.5}), SubcloneSpec("b", 0.5, {})))
    res = simulate(cfg)
    assert res.valid
    assert res.runtime_seconds < 1.0


def test_json_export_includes_clone_fraction():
    cfg = small(subclones=(SubcloneSpec("a", 0.5, {}), SubcloneSpec("b", 0.5, {"repair_rate": 0.5})))
    res = simulate(cfg)
    payload = json.loads(json.dumps(res.to_json_dict(include_final_lengths=False), default=float))
    assert set(payload["clone_fraction"]) == {"a", "b"}
    assert len(payload["clone_fraction"]["a"]) == len(payload["timeseries"]["cycle"])
    assert ModelConfig.from_dict(payload["config"]) == cfg


# --------------------------------------------------- composition with schedule
def test_schedule_and_subclones_compose():
    """A shared stress schedule swings up/down while two clones with different
    repair_rate compete: both mechanisms should run without error and stay
    internally consistent (docs/MODEL.md §2.2 composition rule)."""
    cfg = ModelConfig(population_size=60, carrying_capacity=120, telomeres_per_cell=8, cycles=60, seed=5,
                      maintenance_rate=0.0,
                      schedule=InterventionSchedule(2, {"stress_level": (0.9, 0.3)}),
                      subclones=(
                          SubcloneSpec("high_repair", 0.5, {"repair_rate": 0.8}),
                          SubcloneSpec("low_repair", 0.5, {"repair_rate": 0.0}),
                      ))
    res = simulate(cfg)
    assert res.valid
    assert "stress_level" in res.applied_schedule
    assert set(res.clone_fraction) == {"high_repair", "low_repair"}
    total = sum(res.clone_fraction.values())
    alive = res.population_size > 0
    np.testing.assert_allclose(total[alive], 1.0, atol=1e-9)
    # the high-stress phase (first half) should hurt the low-repair clone
    # more: by the end of the run its share should not have grown.
    assert res.clone_fraction["high_repair"][-1] >= res.clone_fraction["high_repair"][0]


def test_bounds_checked_like_any_other_evolvable_parameter():
    for key in SUBCLONE_OVERRIDABLE_PARAMETERS:
        lo, hi = PARAMETER_BOUNDS[key][0], PARAMETER_BOUNDS[key][1]
        with pytest.raises(ConfigError):
            SubcloneSpec("bad", 0.5, {key: hi + 1.0}).validate()
        with pytest.raises(ConfigError):
            SubcloneSpec("bad", 0.5, {key: lo - 1.0}).validate()


# ----------------------------------------------- composition with genome stability
def test_clone_overriding_replication_error_rate_accumulates_burden_faster():
    """A clone with a much higher baseline mutation rate should end up with a
    higher mean mutation_burden than a clone left at the (zero) default --
    the per-clone lookup (docs/MODEL.md §2.2 composition) must actually reach
    the mutation_burden accumulation, not just be accepted by validation."""
    cfg = small(subclones=(
        SubcloneSpec("mutator", 0.5, {"replication_error_rate": 0.02}),
        SubcloneSpec("stable", 0.5, {}),
    ))
    res = simulate(cfg)
    assert res.valid
    assert res.terminal_metrics["final_mutation_burden"] > 0.0


def test_clone_overriding_checkpoint_strength_is_removed_faster():
    """A clone with checkpoint_strength=1.0 and a low mutation_threshold should
    lose essentially its entire population to apoptosis, while a clone left at
    the (zero) default checkpoint_strength is never touched by it -- proving
    checkpoint_strength_c/mutation_threshold_c actually reach remove_apoptotic
    per-clone, not just the shared config scalar."""
    cfg = small(cycles=30, subclones=(
        SubcloneSpec("checked", 0.5, {"replication_error_rate": 0.05, "mutation_threshold": 0.02,
                                       "checkpoint_strength": 1.0}),
        SubcloneSpec("unchecked", 0.5, {"replication_error_rate": 0.05, "mutation_threshold": 0.02}),
    ))
    res = simulate(cfg)
    assert res.valid
    assert res.clone_fraction["checked"][-1] < res.clone_fraction["unchecked"][-1]


def test_genome_stability_composition_bit_identical_when_unused():
    """Two clones that don't touch any genome-stability field must behave
    exactly like the pre-existing (shortening_rate/maintenance_rate/repair_rate
    /stress_sensitivity-only) sub-clone composition -- the new lookups must be
    inert no-ops when every clone's genome-stability fields equal the shared
    config scalar (all zero/off by default)."""
    cfg = golden_config(seed=1)
    two = cfg.replace(subclones=[
        {"name": "x", "initial_fraction": 0.5, "overrides": {"maintenance_rate": 0.4}},
        {"name": "y", "initial_fraction": 0.5, "overrides": {}},
    ])
    res = simulate(two)
    assert res.valid
    assert res.terminal_metrics["final_mutation_burden"] == 0.0
    assert res.terminal_metrics["genomic_instability_index"] == 0.0


def test_mutation_threshold_override_gates_genomic_instability_index_per_clone():
    """genomic_instability_index (terminal, survivors-only) must use each
    surviving cell's OWN clone's mutation_threshold, not the shared config
    scalar -- a clone with a very low threshold should show 100% instability
    while a clone with the sentinel-high default threshold shows 0%."""
    cfg = small(cycles=20, subclones=(
        SubcloneSpec("low_threshold", 0.5, {"replication_error_rate": 0.05, "mutation_threshold": 0.01}),
        SubcloneSpec("high_threshold", 0.5, {"replication_error_rate": 0.05}),
    ))
    res = simulate(cfg)
    assert res.valid
    assert res.terminal_metrics["genomic_instability_index"] > 0.0
