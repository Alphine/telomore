import numpy as np
import pytest

from telomere_lab.evolution.benchmark import (
    budget_evaluations,
    combined_frame,
    run_ga_benchmark,
    run_nsga2_benchmark,
    run_random_search,
)
from telomere_lab.schemas import EvolutionConfig, ModelConfig, MultiObjectiveConfig

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3)
GENES = ("stress_level", "maintenance_rate", "repair_rate")


def test_random_search_returns_valid_convergence_curve():
    result = run_random_search(FAST, GENES, eval_seeds=(1, 2), n_evaluations=40, seed=0)
    assert result.method == "random_search"
    assert len(result.curve) == 20  # 40 evaluations / 2 seeds per candidate
    n_evals = [p.n_evaluations for p in result.curve]
    assert n_evals == sorted(n_evals)
    assert n_evals[-1] == result.evaluations == 40
    # best-so-far is non-decreasing
    fits = [p.best_fitness_so_far for p in result.curve]
    assert all(b >= a - 1e-9 for a, b in zip(fits, fits[1:]))
    assert np.isfinite(result.final_best_fitness)


def test_budget_matching_across_methods_within_tolerance():
    evo = EvolutionConfig(population_size=8, generations=3, seed=1, free_genes=GENES,
                          eval_seeds=(1, 2), checkpoint_every=0)
    mo = MultiObjectiveConfig(population_size=8, generations=3, seed=1, free_genes=GENES,
                              eval_seeds=(1, 2), objectives=("survival", "cost"), checkpoint_every=0)
    ga = run_ga_benchmark(FAST, evo)
    nsga2 = run_nsga2_benchmark(FAST, mo)
    budget = budget_evaluations(evo.population_size, evo.generations, evo.eval_seeds)
    rs = run_random_search(FAST, GENES, eval_seeds=evo.eval_seeds, n_evaluations=budget, seed=0)

    # random search evaluations should land within one candidate's worth of the nominal budget
    assert abs(rs.evaluations - budget) <= len(evo.eval_seeds)
    # GA/NSGA-II evaluations should not exceed the nominal upper-bound budget
    assert ga.evaluations <= budget
    assert nsga2.evaluations <= budget


def test_comparison_table_has_expected_columns():
    evo = EvolutionConfig(population_size=8, generations=2, seed=2, free_genes=GENES,
                          eval_seeds=(1,), checkpoint_every=0)
    mo = MultiObjectiveConfig(population_size=8, generations=2, seed=2, free_genes=GENES,
                              eval_seeds=(1,), objectives=("survival", "cost"), checkpoint_every=0)
    ga = run_ga_benchmark(FAST, evo)
    nsga2 = run_nsga2_benchmark(FAST, mo)
    rs = run_random_search(FAST, GENES, eval_seeds=(1,), n_evaluations=16, seed=0)

    df = combined_frame([ga, nsga2, rs])
    assert list(df.columns) == ["method", "n_evaluations", "best_fitness_so_far"]
    assert set(df["method"]) == {"GA", "NSGA-II", "random_search"}
    assert len(df) == len(ga.curve) + len(nsga2.curve) + len(rs.curve)


def test_nsga2_benchmark_final_genome_in_bounds():
    from telomere_lab.schemas import PARAMETER_BOUNDS

    mo = MultiObjectiveConfig(population_size=8, generations=2, seed=4, free_genes=GENES,
                              eval_seeds=(1,), objectives=("survival", "cost"), checkpoint_every=0)
    nsga2 = run_nsga2_benchmark(FAST, mo)
    for k, v in nsga2.best_genome.items():
        assert PARAMETER_BOUNDS[k][0] <= v <= PARAMETER_BOUNDS[k][1]


def test_random_search_is_reproducible():
    a = run_random_search(FAST, GENES, eval_seeds=(1, 2), n_evaluations=20, seed=7)
    b = run_random_search(FAST, GENES, eval_seeds=(1, 2), n_evaluations=20, seed=7)
    assert a.best_genome == b.best_genome
    assert a.final_best_fitness == pytest.approx(b.final_best_fitness)
