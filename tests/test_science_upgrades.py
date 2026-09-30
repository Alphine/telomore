"""Science-upgrade mechanisms (docs/MODEL.md sections 2.4-2.8): population
doublings, wall-clock mapping, two-level initial spread, heterogeneous
shortening rate and stochastic senescence. All are default-off and must leave
the pre-existing golden fixtures bit-identical.
"""

from pathlib import Path

import numpy as np
import pytest

from telomere_lab.schemas import EVOLVABLE_PARAMETERS, PARAMETER_BOUNDS, ConfigError, ModelConfig
from telomere_lab.simulator.model import simulate
from telomere_lab.simulator.population import divide, stochastic_arrest, update_senescence
from telomere_lab.simulator.stochastic import initial_lengths_hierarchical, make_rng, shortening_multipliers

FIXTURES = Path(__file__).parent / "fixtures"
NEW_FIELDS = ("hours_per_cycle", "initial_within_cell_sd", "shortening_rate_cv",
              "senescence_softness_bp", "random_arrest_rate")


def golden_config(seed: int, **kw) -> ModelConfig:
    return ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=seed,
                       stress_level=0.6, maintenance_rate=0.3, repair_rate=0.25, **kw)


def small(seed=1, **kw) -> ModelConfig:
    base = dict(population_size=60, carrying_capacity=240, telomeres_per_cell=8, cycles=80, seed=seed,
                senescence_threshold=3500.0)
    base.update(kw)
    return ModelConfig(**base)


# ------------------------------------------------------------------ schema
def test_new_fields_default_off_bounded_and_not_evolvable():
    cfg = ModelConfig()
    for name in NEW_FIELDS:
        assert getattr(cfg, name) == 0.0
        assert name in PARAMETER_BOUNDS
        assert name not in EVOLVABLE_PARAMETERS
        with pytest.raises(ConfigError):
            cfg.replace(**{name: PARAMETER_BOUNDS[name][1] + 1.0}).validate()
        with pytest.raises(ConfigError):
            cfg.replace(**{name: -0.1}).validate()


def test_new_fields_round_trip():
    cfg = ModelConfig(hours_per_cycle=24.0, initial_within_cell_sd=400.0, shortening_rate_cv=0.3,
                      senescence_softness_bp=200.0, random_arrest_rate=0.01)
    assert ModelConfig.from_dict(cfg.to_dict()) == cfg


def test_within_cell_sd_too_large_is_rejected():
    with pytest.raises(ConfigError):
        ModelConfig(initial_within_cell_sd=3000.0).validate()
    ModelConfig(initial_within_cell_sd=800.0).validate()


def test_golden_unchanged_with_all_new_fields_explicitly_zero():
    golden = np.load(FIXTURES / "simulator_golden_v0.1.0.npz")
    zeros = {n: 0.0 for n in NEW_FIELDS}
    for seed in (1, 2):
        res = simulate(golden_config(seed, **zeros))
        np.testing.assert_array_equal(res.mean_length, golden[f"mean_length_seed{seed}"])
        np.testing.assert_array_equal(res.senescent_fraction, golden[f"senescent_fraction_seed{seed}"])
        np.testing.assert_array_equal(res.final_lengths, golden[f"final_lengths_seed{seed}"])


# ------------------------------------------------------- population doublings
def test_pd_hand_computed_single_step():
    # 4 proliferative + 1 senescent cell: division adds 4 daughters -> 9/5 growth.
    lengths = np.full((5, 2), 6000.0)
    senescent = np.array([False, False, False, False, True])
    zeros = np.zeros(5)
    out = divide(lengths, senescent, np.arange(5), np.zeros(5, dtype=int), zeros, zeros)
    assert np.log2(out[0].shape[0] / 5) == pytest.approx(np.log2(9 / 5))


def test_pd_first_cycle_matches_log2_of_growth_and_is_monotone():
    cfg = small(senescent_death_rate=0.0, senescence_threshold=500.0, population_size=50, carrying_capacity=10_000,
                cycles=3)
    res = simulate(cfg)
    pd = res.population_doublings
    assert pd[0] == 0.0
    # nobody senescent, no death, no passaging: exact doubling each cycle
    np.testing.assert_allclose(pd, [0, 1, 2, 3])
    assert res.terminal_metrics["total_pd"] == pytest.approx(3.0)


def test_pd_monotone_and_passaging_does_not_subtract():
    res = simulate(small(carrying_capacity=120, cycles=60))
    pd = res.population_doublings
    assert np.all(np.diff(pd) >= -1e-12)
    # heavy passaging: PD keeps growing far beyond log2(capacity/founders)
    assert pd[-1] > np.log2(120 / 60) + 1.0
    assert res.terminal_metrics["total_pd"] == pd[-1]


def test_pd_independent_of_passage_capacity_in_first_cycle_and_outputs_present():
    a = simulate(small(cycles=1, carrying_capacity=61))
    b = simulate(small(cycles=1, carrying_capacity=5000))
    assert a.population_doublings[1] == b.population_doublings[1]
    frame = a.timeseries_frame()
    assert "population_doublings" in frame and "time_hours" in frame
    assert "population_doublings" in a.to_json_dict()["timeseries"]


def test_pd_failed_result_is_nan():
    bad = simulate(ModelConfig(initial_length=-5.0))
    assert not bad.valid
    assert np.isnan(bad.population_doublings).all()


# ------------------------------------------------------------ wall clock
def test_time_hours_unused_is_nan_and_no_total_days():
    res = simulate(small(cycles=5))
    assert np.isnan(res.time_hours).all()
    assert "total_days" not in res.terminal_metrics


def test_time_hours_used_and_no_effect_on_dynamics():
    base = simulate(small(cycles=10))
    timed = simulate(small(cycles=10, hours_per_cycle=24.0))
    np.testing.assert_allclose(timed.time_hours, timed.time * 24.0)
    assert timed.terminal_metrics["total_days"] == pytest.approx(10.0)
    np.testing.assert_array_equal(base.mean_length, timed.mean_length)
    np.testing.assert_array_equal(base.population_doublings, timed.population_doublings)


# -------------------------------------------------- within/between-cell spread
def test_hierarchical_variance_components():
    rng = make_rng(0)
    x = initial_lengths_hierarchical(rng, 4000, 16, 7500.0, 600.0, 400.0)
    within = (x - x.mean(axis=1, keepdims=True)).std()
    between = x.mean(axis=1).std()
    assert within == pytest.approx(400.0 * np.sqrt(15 / 16), rel=0.05)
    assert between == pytest.approx(np.sqrt(600.0 ** 2 + 400.0 ** 2 / 16), rel=0.05)
    assert x.std() == pytest.approx(np.sqrt(600.0 ** 2 + 400.0 ** 2), rel=0.05)


def test_within_cell_sd_changes_start_state_and_runs():
    plain = simulate(small(cycles=2))
    two = simulate(small(cycles=2, initial_within_cell_sd=300.0))
    assert two.valid
    assert plain.length_cv[0] != two.length_cv[0]
    # the legacy mode uses initial_length_sd (800) as WITHIN-cell spread; here it is
    # the between-cell SD and within is only 300, so the shortest telomere per cell is higher
    assert two.mean_shortest_per_cell[0] > plain.mean_shortest_per_cell[0]


# ------------------------------------------------- heterogeneous shortening
def test_shortening_multiplier_mean_one_and_cv():
    m = shortening_multipliers(make_rng(3), 200_000, 0.4)
    assert m.mean() == pytest.approx(1.0, abs=0.01)
    assert m.std() / m.mean() == pytest.approx(0.4, rel=0.03)
    assert (m > 0).all()


def test_shortening_cv_widens_time_to_senescence_spread():
    def spread(cv):
        t50 = [simulate(small(seed=s, shortening_rate_cv=cv, cycles=120)).terminal_metrics["time_to_50pct_senescence"]
               for s in range(8)]
        return t50
    # per-founder onset spread inside a single culture is the cleaner signal
    def founder_sd(cv):
        vals = []
        for s in range(6):
            r = simulate(small(seed=s, shortening_rate_cv=cv, cycles=120))
            f = r.founder_senescence_cycle
            vals.append(f[f >= 0].std())
        return float(np.mean(vals))
    assert founder_sd(0.5) > founder_sd(0.0)


def test_shortening_mult_is_heritable_through_divide():
    lengths = np.full((3, 2), 6000.0)
    mult = np.array([0.5, 1.0, 2.0])
    z = np.zeros(3)
    out = divide(lengths, np.zeros(3, dtype=bool), np.arange(3), np.zeros(3, dtype=int), z, z, mult)
    np.testing.assert_array_equal(out[-1], np.concatenate([mult, mult]))


# ------------------------------------------------------ stochastic senescence
def test_hazard_off_equals_hard_rule_function():
    lengths = np.array([[2900.0, 5000.0], [3100.0, 4000.0]])
    s0 = np.zeros(2, dtype=bool)
    out = stochastic_arrest(make_rng(0), lengths, s0, 3000.0, 0.0, 0.0)
    np.testing.assert_array_equal(out, update_senescence(lengths, s0, 3000.0))


def test_hazard_probabilities_valid_and_limits():
    n = 20000
    thr = 3000.0
    for shortest, expect in ((thr, 0.5), (thr - 2000, 1.0), (thr + 2000, 0.0)):
        lengths = np.full((n, 1), shortest)
        frac = stochastic_arrest(make_rng(1), lengths, np.zeros(n, dtype=bool), thr, 200.0, 0.0).mean()
        assert frac == pytest.approx(expect, abs=0.02)
    # random arrest alone: length independent, layered on the hard rule
    lengths = np.full((n, 1), 9000.0)
    frac = stochastic_arrest(make_rng(2), lengths, np.zeros(n, dtype=bool), thr, 0.0, 0.05).mean()
    assert frac == pytest.approx(0.05, abs=0.01)
    # already-senescent cells stay senescent
    assert stochastic_arrest(make_rng(3), lengths, np.ones(n, dtype=bool), thr, 200.0, 0.0).all()


def test_hazard_starts_earlier_and_more_spread_than_hard_threshold():
    def onset(**kw):
        firsts, widths = [], []
        for s in range(6):
            r = simulate(small(seed=s, cycles=140, **kw))
            frac = np.nan_to_num(r.senescent_fraction, nan=1.0)
            first = np.flatnonzero(frac > 0.02)
            firsts.append(first[0] if first.size else 140)
            t10 = np.flatnonzero(frac >= 0.1)
            t90 = np.flatnonzero(frac >= 0.9)
            widths.append((t90[0] if t90.size else 140) - (t10[0] if t10.size else 140))
        return np.mean(firsts), np.mean(widths)
    hard_first, hard_width = onset()
    soft_first, soft_width = onset(senescence_softness_bp=400.0)
    assert soft_first < hard_first
    assert soft_width > hard_width


def test_random_arrest_reduces_proliferative_fraction():
    base = simulate(small(cycles=40, senescence_threshold=500.0))
    rnd = simulate(small(cycles=40, senescence_threshold=500.0, random_arrest_rate=0.1))
    assert rnd.senescent_fraction[-1] > base.senescent_fraction[-1]
    assert rnd.valid
