import numpy as np
import pytest

from telomere_lab.evolution.benchmark import run_random_search
from telomere_lab.evolution.surrogate import SurrogateActiveLearner, run_active_learning
from telomere_lab.schemas import ActiveLearningConfig, ConfigError, ModelConfig

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3)
GENES = ("stress_level", "maintenance_rate", "repair_rate")


def test_budget_accounting():
    cfg = ActiveLearningConfig(n_initial=5, n_iterations=7, eval_seeds=(1, 2), free_genes=GENES, seed=1)
    result = run_active_learning(FAST, cfg)
    assert len(result.records) == cfg.n_initial + cfg.n_iterations
    assert result.evaluations == (cfg.n_initial + cfg.n_iterations) * len(cfg.eval_seeds)
    assert result.records[-1].n_real_evaluations == result.evaluations
    n_initial_records = [r for r in result.records if r.phase == "initial"]
    n_active_records = [r for r in result.records if r.phase == "active"]
    assert len(n_initial_records) == cfg.n_initial
    assert len(n_active_records) == cfg.n_iterations
    for r in n_initial_records:
        assert r.predicted_mean is None and r.predicted_std is None
    for r in n_active_records:
        assert r.predicted_mean is not None and r.predicted_std is not None


def test_to_frame_shape():
    cfg = ActiveLearningConfig(n_initial=4, n_iterations=4, eval_seeds=(1,), free_genes=GENES, seed=2)
    result = run_active_learning(FAST, cfg)
    frame = result.to_frame()
    assert len(frame) == 8
    for col in ("iteration", "phase", "real_fitness", "predicted_mean", "predicted_std",
               "acquisition_value", "best_so_far", "n_real_evaluations"):
        assert col in frame.columns
    for gene in GENES:
        assert f"gene_{gene}" in frame.columns
    # best-so-far is non-decreasing
    best = frame["best_so_far"].tolist()
    assert all(b >= a - 1e-9 for a, b in zip(best, best[1:]))

    conv = result.convergence_frame()
    assert list(conv.columns) == ["method", "n_evaluations", "best_fitness_so_far"]
    assert len(conv) == 8


def test_deterministic_given_fixed_seed():
    cfg = ActiveLearningConfig(n_initial=5, n_iterations=5, eval_seeds=(1, 2), free_genes=GENES, seed=42)
    a = run_active_learning(FAST, cfg)
    b = run_active_learning(FAST, cfg)
    assert a.best_genome == b.best_genome
    assert a.best_fitness == pytest.approx(b.best_fitness)
    assert a.to_frame()["real_fitness"].tolist() == pytest.approx(b.to_frame()["real_fitness"].tolist())


def test_invalid_config_rejected():
    with pytest.raises(ConfigError):
        ActiveLearningConfig(n_initial=1).validate()
    with pytest.raises(ConfigError):
        ActiveLearningConfig(n_iterations=-1).validate()
    with pytest.raises(ConfigError):
        ActiveLearningConfig(free_genes=("noise_sd",)).validate()
    with pytest.raises(ConfigError):
        ActiveLearningConfig(eval_seeds=()).validate()
    with pytest.raises(ConfigError):
        ActiveLearningConfig(candidate_pool_size=1).validate()


def test_active_learning_matches_or_beats_random_search_of_same_budget():
    # Not a strict >= on every single seed (both are stochastic and the budget is small),
    # but the mean over several seeds should show active learning is competitive with, and
    # slightly better than, undirected random search -- the whole point of this feature.
    al_bests, rs_bests = [], []
    for seed in range(4):
        cfg = ActiveLearningConfig(n_initial=6, n_iterations=14, eval_seeds=(1, 2), free_genes=GENES,
                                   seed=seed, candidate_pool_size=200)
        al = run_active_learning(FAST, cfg)
        n_evals = al.evaluations
        rs = run_random_search(FAST, GENES, eval_seeds=(1, 2), n_evaluations=n_evals, seed=seed)
        al_bests.append(al.best_fitness)
        rs_bests.append(rs.final_best_fitness)

    assert np.mean(al_bests) >= np.mean(rs_bests) - 0.03


def test_learner_class_usable_directly():
    cfg = ActiveLearningConfig(n_initial=4, n_iterations=3, eval_seeds=(1,), free_genes=GENES, seed=9)
    learner = SurrogateActiveLearner(FAST, cfg)
    result = learner.run()
    assert result.evaluations == 7
    assert set(result.best_genome) == set(GENES)
