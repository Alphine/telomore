"""CLI: run the evolutionary optimizer headlessly.

    python scripts/run_evolution.py --config configs/evolution.yaml --seed 7
    python scripts/run_evolution.py --resume experiments/runs/TEL-20260101-001
    python scripts/run_evolution.py --resume experiments/runs/TEL-20260101-001/generation_010.json --generations 40
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import load_evolution_config  # noqa: E402
from telomere_lab.evolution.engine import EvolutionEngine  # noqa: E402
from telomere_lab.experiments.artifacts import write_evolution_artifacts  # noqa: E402
from telomere_lab.experiments.registry import ExperimentRegistry  # noqa: E402
from telomere_lab.experiments.runner import run_evolution  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="configs/evolution.yaml")
    ap.add_argument("--seed", type=int, default=None, help="override optimizer seed")
    ap.add_argument("--generations", type=int, default=None,
                    help="override total generation budget (with --resume, can extend past the "
                         "originally configured total)")
    ap.add_argument("--population", type=int, default=None)
    ap.add_argument("--no-register", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--resume", default=None, metavar="PATH",
                    help="resume from a checkpoint instead of starting a fresh run. PATH is either "
                         "a specific generation_NNN.json checkpoint file, or a run directory "
                         "containing such files (the highest-numbered checkpoint is used). "
                         "--config is ignored when --resume is given; --seed/--generations/"
                         "--population still apply as overrides on top of the checkpoint's saved "
                         "config.")
    args = ap.parse_args(argv)

    def progress(rec):
        if not args.quiet:
            genes = "  ".join(f"{k}={v:.3f}" for k, v in rec.best_genome.items())
            print(f"gen {rec.generation:3d}  best {rec.best_fitness:+.4f}  "
                  f"mean {rec.mean_fitness:+.4f}  div {rec.diversity:.3f}  | {genes}")

    if args.resume:
        # A fresh run directory (rather than continuing to write checkpoints
        # into the source run's directory) keeps each registered run's
        # artifacts self-contained, matching the fresh-start path.
        registry = None if args.no_register else ExperimentRegistry()
        run_id = registry.new_run_id() if registry else None
        run_dir = registry.run_dir(run_id) if run_id else None
        engine = EvolutionEngine.from_checkpoint(args.resume, run_dir=run_dir)
        resumed_from = engine._resume["generation"]
        print(f"resuming from checkpoint {engine._resume['checkpoint_path']} "
              f"(generation {resumed_from}, {engine.evaluations} evaluations so far)")
        if args.seed is not None:
            engine.evo.seed = args.seed
        if args.generations is not None:
            engine.evo.generations = args.generations
        if args.population is not None:
            engine.evo.population_size = args.population
        engine.evo.validate()

        result = engine.run(callback=progress)
        record = None
        if run_id:
            artifacts = write_evolution_artifacts(result, run_dir)
            record = registry.register(
                kind="evolution",
                run_id=run_id,
                seed=engine.evo.seed,
                configuration={"model": engine.base_config.to_dict(), "evolution": engine.evo.to_dict()},
                fitness=result.best.fitness,
                artifacts=artifacts,
                runtime_seconds=result.runtime_seconds,
                notes=f"resumed from {engine._resume['checkpoint_path']}",
                extra={
                    "baseline_fitness": result.baseline.fitness,
                    "best_genome": result.best.genome,
                    "evaluations": result.evaluations,
                    "generations_completed": len(result.history) - 1,
                    "stopped_early": result.stopped_early,
                    "stop_reason": result.stop_reason,
                    "resumed_from": engine._resume["checkpoint_path"],
                },
            )
    else:
        base, evo = load_evolution_config(args.config)
        if args.seed is not None:
            evo.seed = args.seed
        if args.generations is not None:
            evo.generations = args.generations
        if args.population is not None:
            evo.population_size = args.population
        evo.validate()

        result, record = run_evolution(base, evo, ExperimentRegistry(), callback=progress,
                                       register=not args.no_register)

    print("-" * 72)
    print(f"baseline fitness : {result.baseline.fitness:+.4f}")
    print(f"best fitness     : {result.best.fitness:+.4f}")
    print(f"improvement      : {result.best.fitness - result.baseline.fitness:+.4f}")
    print(f"best genome      : {result.best.genome}")
    print(f"evaluations      : {result.evaluations}   runtime {result.runtime_seconds:.1f}s")
    if result.stopped_early:
        print(f"stopped early    : {result.stop_reason}")
    if record:
        print(f"registered       : {record['run_id']}  -> {record['artifacts']['evolution_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
