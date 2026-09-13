"""Direct unit tests for evolution/fitness.py's shared helpers -- no dedicated
test file existed for these before (they were only ever exercised indirectly
through the GA/NSGA-II/sensitivity/G×E/benchmark/surrogate test suites).

Canalization (docs/MODEL.md §5, docs/ROADMAP.md 2026-09-13 follow-up):
consistency of `survival` across a candidate's eval_seeds replicates. It is
only meaningful for a REPLICATE SET, so compute_fitness() always returns 0.0
for it (a placeholder); only average_breakdowns() computes the real value.
"""

import pytest

from telomere_lab.evolution.fitness import (
    CANALIZATION_CV_SCALE,
    FitnessBreakdown,
    average_breakdowns,
    compute_fitness,
)
from telomere_lab.schemas import FitnessWeights, ModelConfig
from telomere_lab.simulator.model import simulate

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3,
                   maintenance_rate=0.10, repair_rate=0.10)


def _bd(survival: float, valid: bool = True, total: float = 0.0) -> FitnessBreakdown:
    return FitnessBreakdown(total=total, survival=survival, reserve=0.0, senescence=0.0,
                            instability=0.0, cost=0.0, genome_instability=0.0, canalization=0.0,
                            valid=valid, reason=None if valid else "fake invalid")


# --------------------------------------------------------------- compute_fitness
def test_compute_fitness_canalization_placeholder_is_zero():
    res = simulate(FAST)
    assert res.valid
    bd = compute_fitness(res, FitnessWeights())
    assert bd.canalization == 0.0

    # simulate() catches an out-of-bounds ModelConfig at validate() and
    # returns an explicit invalid SimulationResult (SDD §30) -- exercises
    # compute_fitness's other construction path (the invalid early-return).
    bad_res = simulate(FAST.replace(stress_level=-1.0))
    assert not bad_res.valid
    bad_bd = compute_fitness(bad_res, FitnessWeights())
    assert bad_bd.canalization == 0.0


# --------------------------------------------------------------- average_breakdowns
def test_average_breakdowns_identical_survivals_is_fully_canalized():
    items = [_bd(0.8), _bd(0.8), _bd(0.8)]
    bd = average_breakdowns(items, FitnessWeights())
    assert bd.canalization == pytest.approx(1.0)


def test_average_breakdowns_wide_variance_is_zero_canalized():
    items = [_bd(0.9), _bd(0.1), _bd(0.5)]
    bd = average_breakdowns(items, FitnessWeights())
    assert bd.canalization == pytest.approx(0.0)


def test_average_breakdowns_all_zero_survival_is_fully_canalized():
    # mean == 0 -> cv defined as 0.0 -> canalization 1.0 (a perfectly
    # reproducible outcome, even a bad one, has no stochastic ambiguity).
    items = [_bd(0.0), _bd(0.0), _bd(0.0)]
    bd = average_breakdowns(items, FitnessWeights())
    assert bd.canalization == pytest.approx(1.0)


def test_average_breakdowns_matches_formula_for_intermediate_cv():
    import numpy as np

    survivals = [0.6, 0.7, 0.5]
    items = [_bd(s) for s in survivals]
    bd = average_breakdowns(items, FitnessWeights())
    arr = np.array(survivals)
    expected_cv = arr.std() / arr.mean()
    expected = 1.0 - min(1.0, expected_cv / CANALIZATION_CV_SCALE)
    assert bd.canalization == pytest.approx(expected)


def test_average_breakdowns_invalid_short_circuit_unaffected():
    items = [_bd(0.8), _bd(0.5, valid=False), _bd(0.9)]
    bd = average_breakdowns(items, FitnessWeights())
    assert bd.valid is False
    assert bd is items[1]  # returned verbatim, no canalization recomputation


def test_canalization_is_inert_at_default_weight():
    # A moderate, non-maxed-out CV (canalization strictly between 0 and 1),
    # so a nonzero weight has something nonzero to add to total.
    items = [_bd(0.9, total=0.5), _bd(0.85, total=0.1), _bd(0.95, total=0.3)]
    default_weights = FitnessWeights()
    assert default_weights.w_canalization == 0.0
    bd = average_breakdowns(items, default_weights)
    zero_weight_bd = average_breakdowns(items, FitnessWeights(w_canalization=0.0))
    assert bd.total == pytest.approx(zero_weight_bd.total)

    # a nonzero weight raises total (canalization is added, unlike every
    # other optional term so far, which are all subtracted penalties).
    nonzero_weight_bd = average_breakdowns(items, FitnessWeights(w_canalization=1.0))
    assert nonzero_weight_bd.total > bd.total
