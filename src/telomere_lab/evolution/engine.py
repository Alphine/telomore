"""Genetic-algorithm engine (SDD §14).

    1. initialise population      6. crossover
    2. evaluate all genomes        7. mutate
    3. rank by fitness             8. repair invalid genomes
    4. retain elites               9. evaluate next generation
    5. select parents             10. repeat -> return best candidates

The engine is UI-agnostic: progress is reported through an optional
``callback(GenerationRecord)`` and cooperative cancellation through an
optional ``should_stop()`` predicate. Checkpoints (SDD §31) are written to
``run_dir`` when one is given.
"""

from __future__ import annotations

import json
import time as _time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from ..schemas import OPTIMIZER_VERSION, EvolutionConfig, ModelConfig
from ..simulator.model import SimpleTelomereModel
from .crossover import crossover
from .fitness import INVALID_FITNESS, FitnessBreakdown, average_breakdowns, compute_fitness
from .genome import GenomeSpec
from .mutation import gaussian_mutation
from .population import Candidate, ranked
from .selection import select_elites, tournament_select


@dataclass
class GenerationRecord:
    generation: int
    best_fitness: float
    mean_fitness: float
    median_fitness: float
    diversity: float
    best_genome: Dict[str, float]
    best_breakdown: Dict[str, float]
    n_invalid: int
    evaluations_so_far: int
    elapsed_seconds: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EvolutionResult:
    best: Candidate
    baseline: Candidate
    history: List[GenerationRecord]
    final_population: List[Candidate]
    evolution_config: EvolutionConfig
    base_config: ModelConfig
    optimizer_version: str = OPTIMIZER_VERSION
    evaluations: int = 0
    runtime_seconds: float = 0.0
    stopped_early: bool = False
    stop_reason: str = ""
    run_dir: Optional[str] = None

    def best_config(self, seed: int | None = None) -> ModelConfig:
        spec = GenomeSpec(self.base_config, self.evolution_config.free_genes,
                          schedule_phases=self.evolution_config.schedule_phases)
        return spec.to_config(self.best.genome, seed=seed)

    def history_frame(self):
        import pandas as pd

        rows = []
        for h in self.history:
            row = {
                "generation": h.generation,
                "best_fitness": h.best_fitness,
                "mean_fitness": h.mean_fitness,
                "median_fitness": h.median_fitness,
                "diversity": h.diversity,
                "n_invalid": h.n_invalid,
                "evaluations": h.evaluations_so_far,
                "elapsed_seconds": h.elapsed_seconds,
            }
            row.update({f"best_{k}": v for k, v in h.best_genome.items()})
            rows.append(row)
        return pd.DataFrame(rows)

    def population_frame(self):
        import pandas as pd

        rows = []
        for rank, c in enumerate(ranked(self.final_population), start=1):
            row = {"rank": rank, "fitness": c.fitness}
            row.update(c.genome)
            if c.breakdown:
                row.update({
                    "survival": c.breakdown.survival,
                    "reserve": c.breakdown.reserve,
                    "senescence": c.breakdown.senescence,
                    "instability": c.breakdown.instability,
                    "cost": c.breakdown.cost,
                    "valid": c.breakdown.valid,
                })
            rows.append(row)
        return pd.DataFrame(rows)

    def to_json_dict(self) -> Dict[str, Any]:
        return {
            "optimizer_version": self.optimizer_version,
            "evolution_config": self.evolution_config.to_dict(),
            "base_config": self.base_config.to_dict(),
            "best": self.best.to_dict(),
            "baseline": self.baseline.to_dict(),
            "history": [h.to_dict() for h in self.history],
            "final_population": [c.to_dict() for c in self.final_population],
            "evaluations": self.evaluations,
            "runtime_seconds": self.runtime_seconds,
            "stopped_early": self.stopped_early,
            "stop_reason": self.stop_reason,
            "run_dir": self.run_dir,
        }


class EvolutionEngine:
    def __init__(
        self,
        base_config: ModelConfig,
        evo_config: EvolutionConfig,
        model: Optional[SimpleTelomereModel] = None,
        run_dir: str | Path | None = None,
    ):
        self.base_config = base_config.validate()
        self.evo = evo_config.validate()
        self.model = model or SimpleTelomereModel()
        self.spec = GenomeSpec(self.base_config, self.evo.free_genes, self.evo.mutation_sigma,
                               schedule_phases=self.evo.schedule_phases)
        self.rng = np.random.default_rng(self.evo.seed)
        self.run_dir = Path(run_dir) if run_dir else None
        self.evaluations = 0
        self._cache: Dict[str, Candidate] = {}
        self.failure_log: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ eval
    def _key(self, genome: Dict[str, float]) -> str:
        return json.dumps({k: round(float(v), 9) for k, v in sorted(genome.items())})

    def evaluate(self, genome: Dict[str, float]) -> Candidate:
        genome = self.spec.repair(genome)
        key = self._key(genome)
        if key in self._cache:
            return self._cache[key]

        breakdowns: List[FitnessBreakdown] = []
        terminal: Dict[str, Any] = {}
        for s in self.evo.eval_seeds:
            cfg = self.spec.to_config(genome, seed=int(s))
            result = self.model.simulate(cfg)
            self.evaluations += 1
            bd = compute_fitness(result, self.evo.weights)
            if not bd.valid:
                self.failure_log.append({"genome": genome, "seed": int(s), "reason": bd.reason})
            breakdowns.append(bd)
            terminal = result.terminal_metrics
        bd = average_breakdowns(breakdowns)
        cand = Candidate(genome=genome, fitness=bd.total if bd.valid else INVALID_FITNESS,
                         breakdown=bd, terminal_metrics=terminal)
        self._cache[key] = cand
        return cand

    # ------------------------------------------------------------------ run
    def run(
        self,
        callback: Optional[Callable[[GenerationRecord], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> EvolutionResult:
        t0 = _time.perf_counter()
        evo = self.evo
        n = evo.population_size
        n_elites = max(1, int(round(evo.elite_fraction * n))) if evo.elite_fraction > 0 else 0

        genomes = self.spec.random_population(self.rng, n, include_baseline=True)
        population = [self.evaluate(g) for g in genomes]
        baseline = self.evaluate(self.spec.baseline_genome())

        history: List[GenerationRecord] = []
        best_ever = max(population, key=lambda c: c.fitness)
        # Early stopping counts only improvements above the tolerance, but the
        # returned best must be the true maximum (an improvement smaller than
        # the tolerance is still an improvement).
        stall_reference = best_ever.fitness
        stalled = 0
        stopped_early, stop_reason = False, ""

        def record(gen: int) -> GenerationRecord:
            fits = np.array([c.fitness for c in population])
            valid = fits > INVALID_FITNESS / 2
            best = max(population, key=lambda c: c.fitness)
            rec = GenerationRecord(
                generation=gen,
                best_fitness=float(best.fitness),
                mean_fitness=float(fits[valid].mean()) if valid.any() else float("nan"),
                median_fitness=float(np.median(fits[valid])) if valid.any() else float("nan"),
                diversity=self.spec.diversity([c.genome for c in population]),
                best_genome=dict(best.genome),
                best_breakdown=best.breakdown.to_dict() if best.breakdown else {},
                n_invalid=int((~valid).sum()),
                evaluations_so_far=self.evaluations,
                elapsed_seconds=_time.perf_counter() - t0,
            )
            history.append(rec)
            if callback:
                callback(rec)
            return rec

        record(0)
        self._checkpoint(0, population, best_ever)

        for gen in range(1, evo.generations + 1):
            if should_stop and should_stop():
                stopped_early, stop_reason = True, "stopped by user"
                break

            fits = [c.fitness for c in population]
            elites = [population[i] for i in select_elites(fits, n_elites)]
            children: List[Dict[str, float]] = []
            while len(children) < n - n_elites:
                pa = population[tournament_select(fits, self.rng, evo.tournament_size)].genome
                pb = population[tournament_select(fits, self.rng, evo.tournament_size)].genome
                if self.rng.random() < evo.crossover_rate:
                    ca, cb = crossover(evo.crossover_kind, pa, pb, self.spec, self.rng)
                else:
                    ca, cb = dict(pa), dict(pb)
                for child in (ca, cb):
                    child = gaussian_mutation(child, self.spec, self.rng,
                                              evo.mutation_rate, evo.mutation_sigma)
                    children.append(self.spec.repair(child))
            children = children[: n - n_elites]

            population = elites + [self.evaluate(g) for g in children]
            gen_best = max(population, key=lambda c: c.fitness)

            if gen_best.fitness > best_ever.fitness:
                best_ever = gen_best
            if gen_best.fitness > stall_reference + evo.early_stopping_tol:
                stall_reference, stalled = gen_best.fitness, 0
            else:
                stalled += 1

            record(gen)
            if evo.checkpoint_every and gen % evo.checkpoint_every == 0:
                self._checkpoint(gen, population, best_ever)

            if evo.early_stopping_patience and stalled >= evo.early_stopping_patience:
                stopped_early, stop_reason = True, f"no improvement for {stalled} generations"
                break

        result = EvolutionResult(
            best=best_ever,
            baseline=baseline,
            history=history,
            final_population=ranked(population),
            evolution_config=evo,
            base_config=self.base_config,
            evaluations=self.evaluations,
            runtime_seconds=_time.perf_counter() - t0,
            stopped_early=stopped_early,
            stop_reason=stop_reason,
            run_dir=str(self.run_dir) if self.run_dir else None,
        )
        self._finalise(result)
        return result

    # ------------------------------------------------------------ checkpoints
    def _checkpoint(self, generation: int, population: List[Candidate], best: Candidate) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "generation": generation,
            "best_genome": best.genome,
            "best_fitness": best.fitness,
            "population": [c.to_dict() for c in population],
            "random_state": self.rng.bit_generator.state,
            "evolution_config": self.evo.to_dict(),
            "base_config": self.base_config.to_dict(),
            "evaluations": self.evaluations,
        }
        with open(self.run_dir / f"generation_{generation:03d}.json", "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=_json_default)

    def _finalise(self, result: EvolutionResult) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        with open(self.run_dir / "best.json", "w", encoding="utf-8") as fh:
            json.dump(result.best.to_dict(), fh, indent=2, default=_json_default)
        result.history_frame().to_csv(self.run_dir / "summary.csv", index=False)
        if self.failure_log:
            with open(self.run_dir / "failures.json", "w", encoding="utf-8") as fh:
                json.dump(self.failure_log, fh, indent=2, default=_json_default)


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    raise TypeError(f"not JSON serialisable: {type(o)}")
