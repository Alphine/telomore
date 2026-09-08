import numpy as np
import pytest

from telomere_lab.evolution.multiobjective import (
    NSGA2Engine,
    crowding_distance,
    fast_non_dominated_sort,
    hypervolume_2d,
)
from telomere_lab.schemas import PARAMETER_BOUNDS, ConfigError, ModelConfig, MultiObjectiveConfig

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3)
GENES = ("stress_level", "maintenance_rate", "repair_rate")


def dominates(a, b):
    return all(x <= y for x, y in zip(a, b)) and any(x < y for x, y in zip(a, b))


def test_fast_non_dominated_sort_known_case():
    F = np.array([[1, 5], [2, 3], [4, 1], [3, 4], [5, 5], [2, 3]])
    fronts = fast_non_dominated_sort(F)
    assert sorted(fronts[0]) == [0, 1, 2, 5]      # duplicates share the first front
    assert sorted(fronts[1]) == [3]
    assert sorted(fronts[2]) == [4]
    # no member of a front is dominated by another member of the same front
    for front in fronts:
        for i in front:
            for j in front:
                assert not dominates(F[i], F[j])


def test_crowding_distance_extremes_infinite_and_middle_finite():
    F = np.array([[0.0, 1.0], [0.5, 0.5], [1.0, 0.0], [0.4, 0.7]])
    d = crowding_distance(F, [0, 1, 2, 3])
    assert np.isinf(d[0]) and np.isinf(d[2])
    assert np.isfinite(d[1]) and np.isfinite(d[3])
    assert d[1] > 0


def test_hypervolume_2d():
    pts = np.array([[0.2, 0.8], [0.5, 0.5], [0.8, 0.2]])
    hv = hypervolume_2d(pts, np.array([1.0, 1.0]))
    # rectangles: (0.8*0.2) + (0.5*0.3) + (0.2*0.3) = 0.16+0.15+0.06
    assert hv == pytest.approx(0.37)
    assert hypervolume_2d(np.empty((0, 2)), np.array([1.0, 1.0])) == 0.0


def test_config_validation():
    with pytest.raises(ConfigError):
        MultiObjectiveConfig(population_size=7).validate()  # odd
    with pytest.raises(ConfigError):
        MultiObjectiveConfig(objectives=("survival",)).validate()
    with pytest.raises(ConfigError):
        MultiObjectiveConfig(objectives=("survival", "bogus")).validate()


def test_nsga2_smoke_front_is_non_dominated_and_in_bounds(tmp_path):
    cfg = MultiObjectiveConfig(population_size=12, generations=5, seed=1, free_genes=GENES,
                               objectives=("survival", "cost"), checkpoint_every=5)
    result = NSGA2Engine(FAST, cfg, run_dir=tmp_path).run()
    assert result.front, "empty Pareto front"
    vecs = [c.vector for c in result.front]
    for a in vecs:
        for b in vecs:
            assert not dominates(a, b)
    for c in result.front:
        assert c.valid
        for k, v in c.genome.items():
            assert PARAMETER_BOUNDS[k][0] <= v <= PARAMETER_BOUNDS[k][1]
    assert len(result.history) == cfg.generations + 1
    assert result.history[-1].hypervolume >= result.history[0].hypervolume - 1e-9
    assert (tmp_path / "pareto_front.csv").exists()
    assert (tmp_path / "generation_005.json").exists()


def test_nsga2_reproducible_and_three_objectives():
    cfg = MultiObjectiveConfig(population_size=8, generations=3, seed=5, free_genes=GENES,
                               objectives=("survival", "cost", "senescence"), checkpoint_every=0)
    a = NSGA2Engine(FAST, cfg).run()
    b = NSGA2Engine(FAST, cfg).run()
    assert [c.genome for c in a.front] == [c.genome for c in b.front]
    assert all(len(c.vector) == 3 for c in a.front)


def test_population_has_no_duplicate_genomes_and_clones_do_not_share_state():
    cfg = MultiObjectiveConfig(population_size=12, generations=6, seed=2, free_genes=GENES, checkpoint_every=0)
    engine = NSGA2Engine(FAST, cfg)
    res = engine.run()
    keys = [engine._key(c.genome) for c in res.final_population]
    assert len(keys) == len(set(keys)), "duplicate genomes survived selection"
    a = engine.evaluate(res.front[0].genome)
    b = engine.evaluate(res.front[0].genome)
    assert a is not b  # cache returns copies


def test_stop_callback():
    cfg = MultiObjectiveConfig(population_size=8, generations=10, seed=5, free_genes=GENES, checkpoint_every=0)
    seen = []
    res = NSGA2Engine(FAST, cfg).run(callback=lambda r: seen.append(r.generation),
                                     should_stop=lambda: len(seen) >= 2)
    assert res.stopped_early and seen == [0, 1]
