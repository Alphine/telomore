"""The GA must return the true best candidate, independent of the
early-stopping tolerance.

Regression: ``best_ever`` used to advance only when a generation improved by
more than ``early_stopping_tol``, so improvements smaller than the tolerance
were counted in the history but missing from ``result.best`` (seen in
Experiment E run TEL-20260910-001: 0.523447 recorded vs 0.523534 at gen 20).
"""

from __future__ import annotations

from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.schemas import EvolutionConfig, ModelConfig


def test_best_is_the_maximum_of_the_history_even_below_the_tolerance():
    base = ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=1)
    evo = EvolutionConfig(
        population_size=6,
        generations=4,
        seed=5,
        eval_seeds=(1,),
        early_stopping_tol=1.0,  # no improvement ever exceeds this
        early_stopping_patience=0,
    )
    result = EvolutionEngine(base, evo).run()

    history_best = max(h.best_fitness for h in result.history)
    assert result.best.fitness == history_best
    assert result.best.fitness >= result.history[0].best_fitness
    assert result.stopped_early is False
    assert len(result.history) == evo.generations + 1
