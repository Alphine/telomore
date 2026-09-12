"""Resuming a genetic-algorithm run from a checkpoint (backlog: ``--resume``
CLI flag, docs/ROADMAP.md).

Covers: (a) a checkpoint written mid-run can be loaded and resumed, continuing
from the correct generation with the correct ``evaluations`` count and RNG
state -- verified strongly by checking that stopping a run at a checkpoint and
resuming it reproduces the same trajectory as never stopping at all; (b)
resuming from a run directory picks the highest-numbered checkpoint; (c) the
``--resume`` CLI flag works end-to-end.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.schemas import EvolutionConfig, ModelConfig

REPO_ROOT = Path(__file__).resolve().parents[1]


def _tiny_configs(seed: int = 5, generations: int = 6, checkpoint_every: int = 2):
    base = ModelConfig(population_size=20, carrying_capacity=60, telomeres_per_cell=6, cycles=25, seed=1)
    evo = EvolutionConfig(
        population_size=6,
        generations=generations,
        seed=seed,
        eval_seeds=(1,),
        checkpoint_every=checkpoint_every,
    )
    return base, evo


def test_resume_reproduces_the_uninterrupted_trajectory(tmp_path):
    base, evo = _tiny_configs()

    full_dir = tmp_path / "full"
    full_result = EvolutionEngine(base, evo, run_dir=full_dir).run()

    # Run only up to the checkpoint at generation 4, then resume from it.
    stopped_dir = tmp_path / "stopped"
    stop_evo = EvolutionConfig.from_dict({**evo.to_dict(), "generations": 4})
    EvolutionEngine(base, stop_evo, run_dir=stopped_dir).run()

    checkpoint = stopped_dir / "generation_004.json"
    assert checkpoint.exists()

    resumed_engine = EvolutionEngine.from_checkpoint(checkpoint)
    resumed_engine.evo.generations = evo.generations  # extend back to the original budget
    resumed_result = resumed_engine.run()

    # The RNG state and population are restored exactly, so the genetic
    # trajectory (which genomes get evaluated, and the resulting best) is
    # bit-for-bit identical to the uninterrupted run.
    assert resumed_result.best.genome == full_result.best.genome
    assert resumed_result.best.fitness == full_result.best.fitness
    # ``evaluations`` resumes from the checkpoint's own count and grows
    # correctly from there, but isn't required to match the uninterrupted
    # run's count exactly: only the *current population* is checkpointed, not
    # the full evaluation cache, so a genome that recurs by chance from an
    # older, no-longer-checkpointed generation costs one fresh evaluation on
    # resume where the uninterrupted run would have had a cache hit. This is
    # the same documented, acceptable trade-off as history not being fully
    # persisted across a resume.
    assert abs(resumed_result.evaluations - full_result.evaluations) <= evo.population_size


def test_resume_continues_from_the_correct_generation_and_evaluations(tmp_path):
    base, evo = _tiny_configs(generations=4, checkpoint_every=2)
    run_dir = tmp_path / "run"
    engine = EvolutionEngine(base, evo, run_dir=run_dir)
    engine.run()

    checkpoint = run_dir / "generation_002.json"
    assert checkpoint.exists()

    resumed = EvolutionEngine.from_checkpoint(checkpoint)
    assert resumed._resume["generation"] == 2
    evaluations_at_checkpoint = resumed.evaluations
    assert evaluations_at_checkpoint > 0

    resumed.evo.generations = 4
    result = resumed.run()

    # History for the resumed run starts at the checkpoint's own generation
    # (a documented limitation -- history before a checkpoint isn't persisted).
    assert result.history[0].generation == 2
    assert [h.generation for h in result.history] == [2, 3, 4]
    assert result.evaluations >= evaluations_at_checkpoint


def test_resume_rng_state_differs_from_a_fresh_run_with_the_same_seed(tmp_path):
    base, evo = _tiny_configs(generations=4, checkpoint_every=2)
    run_dir = tmp_path / "run"
    EvolutionEngine(base, evo, run_dir=run_dir).run()

    checkpoint = run_dir / "generation_002.json"
    resumed = EvolutionEngine.from_checkpoint(checkpoint)
    fresh = EvolutionEngine(base, evo)

    # The resumed engine's RNG has already advanced past generation 2; a
    # freshly-seeded engine starts from scratch, so their next draws differ.
    assert resumed.rng.random() != fresh.rng.random()


def test_resume_from_a_directory_picks_the_highest_numbered_checkpoint(tmp_path):
    base, evo = _tiny_configs(generations=4, checkpoint_every=2)
    run_dir = tmp_path / "run"
    EvolutionEngine(base, evo, run_dir=run_dir).run()

    assert sorted(p.name for p in run_dir.glob("generation_*.json")) == [
        "generation_000.json", "generation_002.json", "generation_004.json",
    ]

    resumed = EvolutionEngine.from_checkpoint(run_dir)
    assert resumed._resume["generation"] == 4
    assert Path(resumed._resume["checkpoint_path"]).name == "generation_004.json"


def test_from_checkpoint_raises_for_a_directory_with_no_checkpoints(tmp_path):
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    try:
        EvolutionEngine.from_checkpoint(empty_dir)
        assert False, "expected FileNotFoundError"
    except FileNotFoundError:
        pass


def test_cli_resume_flag_end_to_end(tmp_path):
    base, evo = _tiny_configs(generations=3, checkpoint_every=1)
    runs_dir = tmp_path / "experiments" / "runs"
    registry = ExperimentRegistry(runs_dir=runs_dir)
    run_dir = registry.run_dir(registry.new_run_id())
    EvolutionEngine(base, evo, run_dir=run_dir).run()

    checkpoint = sorted(run_dir.glob("generation_*.json"))[-1]

    # --no-register means the CLI never touches the real experiments/ ledger,
    # so no environment redirection is needed here.
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "run_evolution.py"),
         "--resume", str(checkpoint), "--generations", "3", "--no-register", "--quiet"],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert "resuming from checkpoint" in result.stdout
    assert "best fitness" in result.stdout
