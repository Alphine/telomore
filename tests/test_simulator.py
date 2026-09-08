import numpy as np
import pytest

from telomere_lab.schemas import ConfigError, ModelConfig
from telomere_lab.simulator.model import SimpleTelomereModel, maintenance_weights, simulate


def small(**kw) -> ModelConfig:
    base = dict(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=1)
    base.update(kw)
    return ModelConfig(**base)


def test_initial_conditions():
    cfg = small(initial_length=8000, initial_length_sd=0.0)
    res = simulate(cfg)
    assert res.valid
    assert res.population_size[0] == cfg.population_size
    assert res.mean_length[0] == pytest.approx(8000.0)
    assert res.senescent_fraction[0] == 0.0
    assert len(res.time) == cfg.cycles + 1


def test_bounds_rejected():
    with pytest.raises(ConfigError):
        ModelConfig(stress_level=1.5).validate()
    with pytest.raises(ConfigError):
        ModelConfig(senescence_threshold=9000, initial_length=7500).validate()
    with pytest.raises(ConfigError):
        ModelConfig(carrying_capacity=10, population_size=100).validate()


def test_invalid_config_yields_explicit_failure_not_exception():
    cfg = ModelConfig(stress_level=5.0)  # not validated on purpose
    res = SimpleTelomereModel().simulate(cfg)
    assert res.valid is False
    assert "stress_level" in (res.failure_reason or "")
    assert res.terminal_metrics == {}


def test_deterministic_seed():
    a = simulate(small(seed=123))
    b = simulate(small(seed=123))
    c = simulate(small(seed=124))
    np.testing.assert_array_equal(a.mean_length, b.mean_length)
    np.testing.assert_array_equal(a.final_lengths, b.final_lengths)
    assert not np.array_equal(a.mean_length, c.mean_length)


def test_shortening_direction():
    res = simulate(small(maintenance_rate=0.0))
    # With no maintenance, mean length must be non-increasing over time
    # (passaging can only remove cells; division only shortens).
    diffs = np.diff(res.mean_length[~np.isnan(res.mean_length)])
    assert (diffs <= 1e-6).mean() > 0.95
    assert res.mean_length[-1] < res.mean_length[0]


def test_higher_shortening_rate_shortens_faster():
    slow = simulate(small(shortening_rate=30, maintenance_rate=0.0))
    fast = simulate(small(shortening_rate=120, maintenance_rate=0.0))
    assert fast.mean_length[-1] < slow.mean_length[-1]
    assert fast.terminal_metrics["time_to_50pct_senescence"] <= slow.terminal_metrics["time_to_50pct_senescence"]


def test_higher_maintenance_preserves_length():
    low = simulate(small(maintenance_rate=0.0))
    high = simulate(small(maintenance_rate=0.9))
    assert high.mean_length[-1] > low.mean_length[-1]
    assert high.terminal_metrics["final_senescent_fraction"] <= low.terminal_metrics["final_senescent_fraction"]


def test_repair_reduces_stress_damage():
    no_repair = simulate(small(stress_level=1.0, repair_rate=0.0, maintenance_rate=0.0))
    full_repair = simulate(small(stress_level=1.0, repair_rate=1.0, maintenance_rate=0.0))
    assert full_repair.mean_length[-1] > no_repair.mean_length[-1]


def test_senescence_is_irreversible_and_threshold_based():
    res = simulate(small(cycles=80, maintenance_rate=0.0))
    sf = res.senescent_fraction[~np.isnan(res.senescent_fraction)]
    # fraction may drop only via passaging/death noise; it must reach high values eventually
    assert sf[-1] >= 0.5
    assert res.terminal_metrics["time_to_50pct_senescence"] < 80


def test_population_never_exceeds_capacity():
    res = simulate(small(carrying_capacity=60))
    assert res.population_size.max() <= 60


def test_maintenance_weights_prefer_shortest_and_saturate():
    L = np.array([[2000.0, 5000.0, 9000.0]])
    w = maintenance_weights(L, saturation_length=8000.0, reference_length=4000.0)
    assert w[0, 0] > w[0, 1] > w[0, 2]
    assert w[0, 2] == 0.0  # beyond saturation length
    assert w[0, 0] == pytest.approx(1.0)  # shortest & below reference -> full gain
    # a lone telomere between reference and saturation is on the linear ramp
    w2 = maintenance_weights(np.array([[6000.0]]), 8000.0, 4000.0)
    assert w2[0, 0] == pytest.approx(0.5)


def test_runtime_target_default_config():
    res = simulate(ModelConfig())
    assert res.valid
    assert res.runtime_seconds < 1.0, f"default simulation took {res.runtime_seconds:.2f}s"


def test_founder_senescence_cycle_first_passage():
    cfg = small(maintenance_rate=0.0, cycles=80)
    res = simulate(cfg)
    fsc = res.founder_senescence_cycle
    assert fsc.shape == (cfg.population_size,)
    # every founder either senesced by the end (a valid cycle index) or is
    # explicitly censored (-1); with maintenance off, most should senesce.
    assert set(np.unique(fsc[fsc < 0])).issubset({-1})
    assert (fsc >= 0).sum() > 0
    observed = fsc[fsc >= 0]
    assert observed.min() >= 0
    assert observed.max() <= cfg.cycles


def test_founder_senescence_cycle_matches_first_time_shortest_below_threshold():
    # Single founder, no population growth noise from others: verify the
    # recorded cycle is exactly the first cycle its shortest telomere drops
    # below the threshold, by cross-checking against the length trajectory.
    cfg = small(population_size=1, carrying_capacity=1, cycles=100, maintenance_rate=0.0)
    res = simulate(cfg)
    onset = res.founder_senescence_cycle[0]
    assert onset >= 0
    # shortest_length series is population-wide but with 1 cell it's exact.
    below = np.flatnonzero(res.shortest_length < cfg.senescence_threshold)
    assert below.size and int(below[0]) == onset


def test_hayflick_distribution_summary():
    from telomere_lab.simulator.metrics import hayflick_distribution

    fsc = np.array([5, 10, 15, -1, -1])
    d = hayflick_distribution(fsc)
    assert d["n_founders"] == 5
    assert d["n_observed"] == 3
    assert d["censored_fraction"] == pytest.approx(0.4)
    assert d["mean_generations"] == pytest.approx(10.0)
    assert d["median_generations"] == pytest.approx(10.0)

    all_censored = hayflick_distribution(np.full(4, -1))
    assert all_censored["n_observed"] == 0
    assert all_censored["censored_fraction"] == 1.0
    assert np.isnan(all_censored["mean_generations"])


def test_json_roundtrip_config():
    cfg = ModelConfig(stress_level=0.33, cycles=17)
    again = ModelConfig.from_dict(cfg.to_dict())
    assert again == cfg
    assert cfg.config_hash() == cfg.replace(seed=999).config_hash()
    assert cfg.config_hash() != cfg.replace(stress_level=0.5).config_hash()
