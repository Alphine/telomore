"""Multiprocessing for parallel fitness evaluation (backlog, docs/ROADMAP.md).

Covers: (a) ``n_workers`` is strictly opt-in and additive -- a parallel run
from the same seed reproduces the exact same genetic trajectory as a serial
one, bit-for-bit, since ``self.rng`` is only ever touched in the main
process; (b) genomes already in ``self._cache`` (e.g. elites carried into the
next generation) are not re-submitted to the worker pool and don't inflate
``evaluations``; (c) the CLI ``--workers`` flag works end-to-end.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.schemas import EvolutionConfig, ModelConfig

REPO_ROOT = Path(__file__).resolve().parents[1]


def _tiny_configs(seed: int = 5, generations: int = 4):
    base = ModelConfig(population_size=20, carrying_capacity=60, telomeres_per_cell=6, cycles=25, seed=1)
    evo = EvolutionConfig(
        population_size=6,
        generations=generations,
        seed=seed,
        eval_seeds=(1,),
        elite_fraction=1.0 / 6,  # keep >=1 elite so cache reuse across generations is exercised
    )
    return base, evo


def test_parallel_matches_serial_bit_for_bit(tmp_path):
    base, evo = _tiny_configs()

    serial_result = EvolutionEngine(base, evo, n_workers=1).run()
    parallel_result = EvolutionEngine(base, evo, n_workers=2).run()

    assert parallel_result.best.genome == serial_result.best.genome
    assert parallel_result.best.fitness == serial_result.best.fitness
    assert parallel_result.evaluations == serial_result.evaluations
    assert len(parallel_result.history) == len(serial_result.history)
    for ph, sh in zip(parallel_result.history, serial_result.history):
        assert ph.generation == sh.generation
        assert ph.best_fitness == sh.best_fitness
        assert ph.mean_fitness == sh.mean_fitness or (
            ph.mean_fitness != ph.mean_fitness and sh.mean_fitness != sh.mean_fitness  # both NaN
        )
        assert ph.best_genome == sh.best_genome


def test_cached_genomes_are_not_resubmitted_to_the_pool():
    base, evo = _tiny_configs(generations=3)
    # elite_fraction keeps at least one candidate identical (and thus cached)
    # across every generation boundary; confirm the parallel run's
    # `evaluations` count matches the serial run's exactly, which would only
    # hold if cache hits skip the pool (a re-submitted cached genome would
    # still return the correct fitness, but would double the seed-simulations
    # counted for it).
    serial = EvolutionEngine(base, evo, n_workers=1).run()
    parallel = EvolutionEngine(base, evo, n_workers=2).run()
    assert parallel.evaluations == serial.evaluations

    # Directly check the batch helper: submitting a genome already in
    # ``_cache`` must resolve without touching the pool at all.
    engine = EvolutionEngine(base, evo, n_workers=2)
    engine._pool = None  # no pool created; a cache-miss submission here would raise
    baseline_genome = engine.spec.baseline_genome()
    cand = engine.evaluate(baseline_genome)  # populates the cache serially
    results = engine._evaluate_batch([baseline_genome])
    assert results == [cand]


def test_cli_workers_flag_end_to_end(tmp_path):
    base, evo = _tiny_configs(generations=2)
    config_path = tmp_path / "evo.yaml"
    config_path.write_text(
        "model:\n"
        f"  population_size: {base.population_size}\n"
        f"  carrying_capacity: {base.carrying_capacity}\n"
        f"  telomeres_per_cell: {base.telomeres_per_cell}\n"
        f"  cycles: {base.cycles}\n"
        f"  seed: {base.seed}\n"
        "evolution:\n"
        f"  population_size: {evo.population_size}\n"
        f"  generations: {evo.generations}\n"
        f"  seed: {evo.seed}\n"
        "  eval_seeds: [1]\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "run_evolution.py"),
         "--config", str(config_path), "--workers", "2", "--no-register", "--quiet"],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert "best fitness" in result.stdout
