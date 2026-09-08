import numpy as np
import pytest

from telomere_lab.evolution.fitness import INVALID_FITNESS, compute_fitness
from telomere_lab.schemas import FitnessWeights, ModelConfig
from telomere_lab.simulator import metrics as M
from telomere_lab.simulator.model import SimpleTelomereModel, simulate


def test_summarise_state_basic():
    lengths = np.array([[4000.0, 6000.0], [2000.0, 8000.0]])
    senescent = np.array([False, True])
    s = M.summarise_state(lengths, senescent, threshold=3000.0)
    assert s["mean_length"] == pytest.approx(5000.0)
    assert s["shortest_length"] == 2000.0
    assert s["mean_shortest_per_cell"] == pytest.approx(3000.0)
    assert s["senescent_fraction"] == 0.5
    assert s["population_size"] == 2
    assert s["proliferative_count"] == 1
    assert s["fraction_below_threshold"] == 0.25


def test_summarise_empty_population():
    s = M.summarise_state(np.empty((0, 4)), np.zeros(0, dtype=bool), 3000.0)
    assert s["population_size"] == 0
    assert np.isnan(s["mean_length"])


def test_time_to_fraction():
    sf = np.array([0.0, 0.1, 0.4, 0.6, 0.9])
    assert M.time_to_fraction(sf, 0.5) == 3.0
    assert M.time_to_fraction(sf, 0.95) == float("inf")


def test_terminal_metrics_bounded():
    res = simulate(ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30))
    tm = res.terminal_metrics
    assert 0.0 <= tm["normalized_survival"] <= 1.0
    assert 0.0 <= tm["normalized_telomere_reserve"] <= 1.0
    assert 0.0 <= tm["final_senescent_fraction"] <= 1.0
    assert tm["peak_population_size"] <= 40


def test_fitness_uses_weights_and_is_finite():
    res = simulate(ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30))
    w = FitnessWeights(1, 0, 0, 0, 0)
    bd = compute_fitness(res, w)
    assert bd.valid
    assert bd.total == pytest.approx(bd.survival)
    w2 = FitnessWeights(0, 0, 1, 0, 0)
    assert compute_fitness(res, w2).total == pytest.approx(-bd.senescence)


def test_invalid_simulation_gets_large_negative_fitness():
    bad = SimpleTelomereModel().simulate(ModelConfig(stress_level=42.0))
    bd = compute_fitness(bad, FitnessWeights())
    assert not bd.valid
    assert bd.total == INVALID_FITNESS
