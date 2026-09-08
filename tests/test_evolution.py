import json

import numpy as np
import pytest

from telomere_lab.evolution.crossover import arithmetic_crossover, uniform_crossover
from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.evolution.genome import GenomeSpec
from telomere_lab.evolution.mutation import gaussian_mutation
from telomere_lab.evolution.selection import select_elites, tournament_select
from telomere_lab.schemas import PARAMETER_BOUNDS, EvolutionConfig, ModelConfig

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3)
GENES = ("stress_level", "maintenance_rate", "repair_rate")


def in_bounds(genome):
    return all(PARAMETER_BOUNDS[k][0] <= v <= PARAMETER_BOUNDS[k][1] for k, v in genome.items())


def test_genome_bounds_and_roundtrip():
    spec = GenomeSpec(FAST, GENES)
    rng = np.random.default_rng(0)
    for _ in range(50):
        g = spec.random_genome(rng)
        assert in_bounds(g)
        assert spec.from_array(spec.to_array(g)) == pytest.approx(g)
    assert spec.repair({"stress_level": 5.0, "maintenance_rate": -1, "repair_rate": 0.5}) == {
        "stress_level": 1.0, "maintenance_rate": 0.0, "repair_rate": 0.5}


def test_mutation_bounds():
    spec = GenomeSpec(FAST, GENES)
    rng = np.random.default_rng(1)
    g = spec.baseline_genome()
    for _ in range(200):
        g = gaussian_mutation(g, spec, rng, mutation_rate=1.0, sigma=0.8)
        assert in_bounds(g)


def test_crossover():
    spec = GenomeSpec(FAST, GENES)
    rng = np.random.default_rng(2)
    a = {"stress_level": 0.0, "maintenance_rate": 0.0, "repair_rate": 0.0}
    b = {"stress_level": 1.0, "maintenance_rate": 1.0, "repair_rate": 1.0}
    ca, cb = uniform_crossover(a, b, spec, rng)
    for g in GENES:
        assert {ca[g], cb[g]} == {0.0, 1.0}
    ca, cb = arithmetic_crossover(a, b, spec, rng)
    for g in GENES:
        assert 0.0 <= ca[g] <= 1.0
        assert ca[g] + cb[g] == pytest.approx(1.0)


def test_selection():
    fit = [0.1, 0.9, 0.5, -3.0]
    assert select_elites(fit, 2) == [1, 2]
    rng = np.random.default_rng(0)
    picks = [tournament_select(fit, rng, tournament_size=4) for _ in range(20)]
    assert set(picks) == {1}  # full tournament always returns the best


def test_convergence_smoke_and_checkpoints(tmp_path):
    evo = EvolutionConfig(population_size=12, generations=6, seed=11, free_genes=GENES, checkpoint_every=3)
    engine = EvolutionEngine(FAST, evo, run_dir=tmp_path)
    result = engine.run()
    assert result.best.fitness >= result.baseline.fitness
    assert result.best.fitness >= result.history[0].best_fitness
    assert all(in_bounds(c.genome) for c in result.final_population)
    assert len(result.history) == evo.generations + 1
    assert (tmp_path / "generation_000.json").exists()
    assert (tmp_path / "generation_003.json").exists()
    assert (tmp_path / "best.json").exists()
    ckpt = json.loads((tmp_path / "generation_003.json").read_text())
    assert ckpt["generation"] == 3 and "random_state" in ckpt


def test_evolution_is_reproducible():
    evo = EvolutionConfig(population_size=8, generations=3, seed=5, free_genes=GENES, checkpoint_every=0)
    a = EvolutionEngine(FAST, evo).run()
    b = EvolutionEngine(FAST, evo).run()
    assert a.best.genome == b.best.genome
    assert [h.best_fitness for h in a.history] == [h.best_fitness for h in b.history]


def test_stop_callback_and_progress_callback():
    evo = EvolutionConfig(population_size=8, generations=10, seed=5, free_genes=GENES, checkpoint_every=0)
    seen = []
    result = EvolutionEngine(FAST, evo).run(callback=lambda r: seen.append(r.generation),
                                            should_stop=lambda: len(seen) >= 3)
    assert result.stopped_early
    assert seen == [0, 1, 2]


def test_invalid_config_rejected():
    from telomere_lab.schemas import ConfigError
    with pytest.raises(ConfigError):
        EvolutionConfig(free_genes=("noise_sd",)).validate()
    with pytest.raises(ConfigError):
        EvolutionConfig(population_size=2).validate()


def test_eval_seeds_default_is_multi_seed():
    assert EvolutionConfig().eval_seeds == (1, 2, 3)


def test_multi_seed_averaging_is_deterministic_and_scales_evaluations():
    evo_single = EvolutionConfig(population_size=8, generations=2, seed=9, free_genes=GENES,
                                 eval_seeds=(1,), checkpoint_every=0)
    evo_multi = EvolutionConfig(population_size=8, generations=2, seed=9, free_genes=GENES,
                                eval_seeds=(1, 2, 3), checkpoint_every=0)
    a = EvolutionEngine(FAST, evo_multi).run()
    b = EvolutionEngine(FAST, evo_multi).run()
    assert a.best.genome == b.best.genome
    assert a.best.fitness == pytest.approx(b.best.fitness)
    assert a.evaluations == b.evaluations

    single = EvolutionEngine(FAST, evo_single).run()
    # same genomes visited (same optimizer seed) -> 3x the simulator calls per genome
    assert a.evaluations == 3 * single.evaluations


def test_single_seed_still_works():
    evo_single = EvolutionConfig(population_size=8, generations=2, seed=9, free_genes=GENES,
                                 eval_seeds=(42,), checkpoint_every=0)
    result = EvolutionEngine(FAST, evo_single).run()
    assert result.best.fitness >= result.baseline.fitness - 1e-6
    assert all(in_bounds(c.genome) for c in result.final_population)
