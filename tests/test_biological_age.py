import numpy as np
import pytest

from telomere_lab.schemas import ModelConfig
from telomere_lab.simulator.biomarker import BiologicalAgeScore, biological_age_score
from telomere_lab.simulator.model import simulate


def small(**kw) -> ModelConfig:
    base = dict(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=1)
    base.update(kw)
    return ModelConfig(**base)


def test_attached_to_simulation_result():
    res = simulate(small())
    assert res.biological_age is not None
    assert isinstance(res.biological_age, BiologicalAgeScore)
    assert res.biological_age.valid


def test_youthful_trajectory_scores_near_youthful_end():
    res = simulate(small(maintenance_rate=0.9, stress_level=0.0, cycles=40))
    score = res.biological_age
    assert score.valid
    assert score.final_score < 30.0, f"expected a low (youthful) score, got {score.final_score}"


def test_senescent_trajectory_scores_near_senescent_end():
    res = simulate(small(maintenance_rate=0.0, stress_level=1.0, repair_rate=0.0, cycles=80))
    score = res.biological_age
    assert score.valid
    assert score.final_score > 70.0, f"expected a high (senescent) score, got {score.final_score}"


def test_youthful_scores_lower_than_senescent():
    youthful = simulate(small(maintenance_rate=0.9, stress_level=0.0, cycles=40)).biological_age
    senescent = simulate(small(maintenance_rate=0.0, stress_level=1.0, repair_rate=0.0, cycles=80)).biological_age
    assert youthful.final_score < senescent.final_score


def test_score_over_time_matches_time_axis_length():
    res = simulate(small())
    assert res.biological_age.score_over_time.shape == res.time.shape


def test_score_generally_rises_over_a_declining_health_trajectory():
    # A monotonically-declining-health scenario (no maintenance, high stress,
    # no repair): don't require strict step-by-step monotonicity (the
    # underlying per-cycle metrics have stochastic noise), but the score
    # should be clearly higher (older) at the end than at the start, and the
    # back half of the run should average higher than the front half.
    res = simulate(small(maintenance_rate=0.0, stress_level=0.8, repair_rate=0.0, cycles=100))
    series = res.biological_age.score_over_time
    assert series[-1] > series[0]
    half = len(series) // 2
    assert series[half:].mean() >= series[:half].mean()


def test_invalid_result_returns_explicit_empty_score_not_crash():
    cfg = ModelConfig(stress_level=5.0)  # invalid, not validated on purpose
    from telomere_lab.simulator.model import SimpleTelomereModel

    res = SimpleTelomereModel().simulate(cfg)
    assert res.valid is False
    score = res.biological_age
    assert score is not None
    assert score.valid is False
    assert score.final_score is None
    assert score.score_over_time.size == 0

    # Calling the function directly on an already-invalid result must also
    # never crash or produce NaN.
    score2 = biological_age_score(res)
    assert score2.valid is False
    assert score2.final_score is None


def test_extinct_culture_saturates_at_senescent_end():
    # Extreme stress + no repair/maintenance + high death rate to force
    # extinction within a short run.
    cfg = small(
        maintenance_rate=0.0,
        stress_level=1.0,
        repair_rate=0.0,
        senescent_death_rate=0.5,
        senescence_threshold=5900,
        initial_length=6000,
        stress_sensitivity=300,
        cycles=60,
    )
    res = simulate(cfg)
    assert res.terminal_metrics.get("extinct") is True
    score = res.biological_age
    assert score.valid
    assert score.final_score == pytest.approx(100.0)
    # every cycle once extinct must be pinned to 100, not NaN or partial credit
    extinct_mask = res.population_size == 0
    assert extinct_mask.any()
    assert np.all(score.score_over_time[extinct_mask] == pytest.approx(100.0))
    assert not np.isnan(score.score_over_time).any()


def test_deterministic_same_input_twice():
    cfg = small(maintenance_rate=0.3, stress_level=0.5, cycles=50)
    res1 = simulate(cfg)
    res2 = simulate(cfg)
    score1 = biological_age_score(res1)
    score2 = biological_age_score(res2)
    assert score1.final_score == score2.final_score
    np.testing.assert_array_equal(score1.score_over_time, score2.score_over_time)

    # Calling twice on the very same result object is also deterministic.
    score1b = biological_age_score(res1)
    assert score1b.final_score == score1.final_score
    np.testing.assert_array_equal(score1b.score_over_time, score1.score_over_time)


def test_score_bounded_0_to_100():
    for cfg in (
        small(maintenance_rate=1.0, stress_level=0.0),
        small(maintenance_rate=0.0, stress_level=1.0, repair_rate=0.0),
        small(),
    ):
        score = simulate(cfg).biological_age
        assert score.valid
        assert 0.0 <= score.final_score <= 100.0
        assert np.all(score.score_over_time >= 0.0)
        assert np.all(score.score_over_time <= 100.0)


def test_scale_label_and_formula_note_present():
    res = simulate(small())
    score = res.biological_age
    assert "0" in score.scale_label and "100" in score.scale_label
    assert score.formula_note  # non-empty
    assert "not a validated" in score.formula_note or "not a" in score.formula_note


def test_to_json_dict_round_trips():
    res = simulate(small())
    data = res.to_json_dict()
    assert "biological_age" in data
    ba = data["biological_age"]
    assert ba["valid"] is True
    assert isinstance(ba["score_over_time"], list)
    assert len(ba["score_over_time"]) == len(res.time)
    assert isinstance(ba["final_score"], float)
    assert ba["scale_label"] == score_scale_label(res)


def score_scale_label(res):
    return res.biological_age.scale_label
