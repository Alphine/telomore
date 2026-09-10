"""NSGA-II multi-objective search (Deb et al. 2002) over the same genome.

Instead of collapsing outcomes into one weighted fitness, this engine keeps a
**Pareto front**: the set of candidates for which no other candidate is at
least as good on every objective and strictly better on one. The user then
sees the trade-off surface (e.g. survival vs. intervention cost) rather than
a single "winner" whose position depends on arbitrary weights.

Algorithm per generation
------------------------
1. binary tournament on (rank, crowding distance) -> parents
2. crossover + Gaussian mutation (shared operators) -> offspring Q
3. R = P ∪ Q; fast non-dominated sort; fill next P front by front, the last
   front truncated by crowding distance (prefers spread-out solutions)

All objectives are converted to *minimisation* internally by negating the
"max" ones declared in ``schemas.OBJECTIVES``.
"""

from __future__ import annotations

import copy
import json
import time as _time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

from ..schemas import OBJECTIVES, OPTIMIZER_VERSION, ModelConfig, MultiObjectiveConfig
from ..simulator.model import SimpleTelomereModel
from .crossover import crossover
from .engine import _json_default
from .fitness import FitnessBreakdown, average_breakdowns, compute_fitness
from .genome import GenomeSpec
from .mutation import gaussian_mutation


# --------------------------------------------------------------------- core
def fast_non_dominated_sort(F: np.ndarray) -> List[List[int]]:
    """Return fronts (lists of row indices) for a minimisation matrix ``F`` (n × m)."""
    n = F.shape[0]
    if n == 0:
        return []
    # dominates[i, j] True if i dominates j
    le = np.all(F[:, None, :] <= F[None, :, :], axis=2)
    lt = np.any(F[:, None, :] < F[None, :, :], axis=2)
    dominates = le & lt
    n_dominated_by = dominates.sum(axis=0)          # how many dominate j
    fronts: List[List[int]] = []
    current = list(np.flatnonzero(n_dominated_by == 0))
    remaining = n_dominated_by.copy()
    while current:
        fronts.append(current)
        nxt = []
        for i in current:
            for j in np.flatnonzero(dominates[i]):
                remaining[j] -= 1
                if remaining[j] == 0:
                    nxt.append(int(j))
        current = nxt
    return fronts


def crowding_distance(F: np.ndarray, front: Sequence[int]) -> np.ndarray:
    """Crowding distance of each member of ``front`` (larger = more isolated)."""
    k = len(front)
    dist = np.zeros(k)
    if k <= 2:
        dist[:] = np.inf
        return dist
    sub = F[list(front)]
    for m in range(sub.shape[1]):
        order = np.argsort(sub[:, m], kind="stable")
        vals = sub[order, m]
        span = vals[-1] - vals[0]
        dist[order[0]] = dist[order[-1]] = np.inf
        if span <= 0:
            continue
        dist[order[1:-1]] += (vals[2:] - vals[:-2]) / span
    return dist


def hypervolume_2d(points: np.ndarray, reference: np.ndarray) -> float:
    """Exact 2-D hypervolume (minimisation) w.r.t. ``reference``. 0 for m != 2."""
    if points.size == 0 or points.shape[1] != 2:
        return 0.0
    pts = points[np.all(points <= reference, axis=1)]
    if pts.size == 0:
        return 0.0
    pts = pts[np.argsort(pts[:, 0])]
    hv, prev_y = 0.0, reference[1]
    for x, y in pts:
        if y < prev_y:
            hv += (reference[0] - x) * (prev_y - y)
            prev_y = y
    return float(hv)


# ---------------------------------------------------------------- containers
@dataclass
class MOCandidate:
    genome: Dict[str, float]
    objectives: Dict[str, float]          # raw values in their natural direction
    vector: List[float]                    # minimisation vector
    scalar_fitness: float                  # reference weighted fitness (not used for selection)
    valid: bool = True
    rank: int = -1
    crowding: float = 0.0
    breakdown: Optional[FitnessBreakdown] = None
    terminal_metrics: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "genome": self.genome, "objectives": self.objectives, "vector": self.vector,
            "scalar_fitness": self.scalar_fitness, "valid": self.valid, "rank": self.rank,
            "crowding": None if np.isinf(self.crowding) else self.crowding,
            "breakdown": self.breakdown.to_dict() if self.breakdown else None,
            "terminal_metrics": self.terminal_metrics,
        }


@dataclass
class MOGenerationRecord:
    generation: int
    front_size: int
    hypervolume: float
    n_invalid: int
    objective_means: Dict[str, float]
    objective_best: Dict[str, float]
    evaluations_so_far: int
    elapsed_seconds: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ParetoResult:
    front: List[MOCandidate]
    baseline: MOCandidate
    final_population: List[MOCandidate]
    history: List[MOGenerationRecord]
    mo_config: MultiObjectiveConfig
    base_config: ModelConfig
    reference_point: List[float]
    optimizer_version: str = OPTIMIZER_VERSION
    evaluations: int = 0
    runtime_seconds: float = 0.0
    stopped_early: bool = False
    run_dir: Optional[str] = None

    def front_frame(self):
        import pandas as pd

        rows = []
        for c in sorted(self.front, key=lambda c: c.vector[0]):
            row = {"scalar_fitness": c.scalar_fitness}
            row.update(c.objectives)
            row.update(c.genome)
            row["crowding"] = c.crowding
            rows.append(row)
        return pd.DataFrame(rows)

    def population_frame(self):
        import pandas as pd

        rows = []
        for c in self.final_population:
            row = {"rank": c.rank, "scalar_fitness": c.scalar_fitness, "valid": c.valid}
            row.update(c.objectives)
            row.update(c.genome)
            rows.append(row)
        return pd.DataFrame(rows)

    def history_frame(self):
        import pandas as pd

        rows = []
        for h in self.history:
            row = {"generation": h.generation, "front_size": h.front_size, "hypervolume": h.hypervolume,
                   "n_invalid": h.n_invalid, "evaluations": h.evaluations_so_far,
                   "elapsed_seconds": h.elapsed_seconds}
            row.update({f"mean_{k}": v for k, v in h.objective_means.items()})
            row.update({f"best_{k}": v for k, v in h.objective_best.items()})
            rows.append(row)
        return pd.DataFrame(rows)

    def to_json_dict(self) -> Dict[str, Any]:
        return {
            "optimizer_version": self.optimizer_version,
            "algorithm": "NSGA-II",
            "mo_config": self.mo_config.to_dict(),
            "base_config": self.base_config.to_dict(),
            "reference_point": self.reference_point,
            "baseline": self.baseline.to_dict(),
            "front": [c.to_dict() for c in self.front],
            "final_population": [c.to_dict() for c in self.final_population],
            "history": [h.to_dict() for h in self.history],
            "evaluations": self.evaluations,
            "runtime_seconds": self.runtime_seconds,
            "stopped_early": self.stopped_early,
            "run_dir": self.run_dir,
        }


# ------------------------------------------------------------------- engine
class NSGA2Engine:
    def __init__(self, base_config: ModelConfig, mo_config: MultiObjectiveConfig,
                 model: Optional[SimpleTelomereModel] = None, run_dir: str | Path | None = None):
        self.base_config = base_config.validate()
        self.cfg = mo_config.validate()
        self.model = model or SimpleTelomereModel()
        self.spec = GenomeSpec(self.base_config, self.cfg.free_genes, self.cfg.mutation_sigma,
                               schedule_phases=self.cfg.schedule_phases)
        self.rng = np.random.default_rng(self.cfg.seed)
        self.run_dir = Path(run_dir) if run_dir else None
        self.evaluations = 0
        self._cache: Dict[str, MOCandidate] = {}
        self.signs = np.array([1.0 if OBJECTIVES[o][0] == "min" else -1.0 for o in self.cfg.objectives])
        # Every objective lives in [0, 1]. In minimisation space a "min" objective's worst value
        # is 1 and a negated "max" objective's worst value is 0, so this is the nadir/reference.
        self.reference = np.array([1.0 if s > 0 else 0.0 for s in self.signs])

    # --------------------------------------------------------------- eval
    def _key(self, genome: Dict[str, float]) -> str:
        return json.dumps({k: round(float(v), 9) for k, v in sorted(genome.items())})

    def evaluate(self, genome: Dict[str, float]) -> MOCandidate:
        genome = self.spec.repair(genome)
        key = self._key(genome)
        if key in self._cache:
            # Return a *copy*: rank/crowding are per-population attributes and clones must not
            # share them (a shared object let one boundary clone give every clone infinite crowding).
            return copy.copy(self._cache[key])
        bds: List[FitnessBreakdown] = []
        terminal: Dict[str, Any] = {}
        for s in self.cfg.eval_seeds:
            res = self.model.simulate(self.spec.to_config(genome, seed=int(s)))
            self.evaluations += 1
            bds.append(compute_fitness(res, self.cfg.weights))
            terminal = res.terminal_metrics
        bd = average_breakdowns(bds)
        if bd.valid:
            objs = {o: float(getattr(bd, o)) for o in self.cfg.objectives}
            vec = [float(v * s) for v, s in zip(objs.values(), self.signs)]
        else:  # invalid: worst possible corner so it is dominated by everything valid
            objs = {o: (1.0 if OBJECTIVES[o][0] == "min" else 0.0) for o in self.cfg.objectives}
            vec = [2.0] * len(self.cfg.objectives)
        cand = MOCandidate(genome=genome, objectives=objs, vector=vec,
                           scalar_fitness=bd.total, valid=bd.valid, breakdown=bd, terminal_metrics=terminal)
        self._cache[key] = cand
        return cand

    # ------------------------------------------------------------ helpers
    def _assign_ranks(self, pop: List[MOCandidate]) -> List[List[int]]:
        F = np.array([c.vector for c in pop])
        fronts = fast_non_dominated_sort(F)
        for r, front in enumerate(fronts):
            cd = crowding_distance(F, front)
            for i, d in zip(front, cd):
                pop[i].rank, pop[i].crowding = r, float(d)
        return fronts

    def _tournament(self, pop: List[MOCandidate]) -> MOCandidate:
        i, j = self.rng.choice(len(pop), size=2, replace=False)
        a, b = pop[i], pop[j]
        if a.rank != b.rank:
            return a if a.rank < b.rank else b
        return a if a.crowding >= b.crowding else b

    def _offspring(self, pop: List[MOCandidate]) -> List[Dict[str, float]]:
        children: List[Dict[str, float]] = []
        while len(children) < len(pop):
            pa, pb = self._tournament(pop).genome, self._tournament(pop).genome
            if self.rng.random() < self.cfg.crossover_rate:
                ca, cb = crossover(self.cfg.crossover_kind, pa, pb, self.spec, self.rng)
            else:
                ca, cb = dict(pa), dict(pb)
            for child in (ca, cb):
                child = gaussian_mutation(child, self.spec, self.rng, self.cfg.mutation_rate,
                                          self.cfg.mutation_sigma)
                children.append(self.spec.repair(child))
        return children[: len(pop)]

    def _select_next(self, combined: List[MOCandidate], n: int) -> List[MOCandidate]:
        # Duplicate genomes carry no information and, left alone, take over the population
        # (standard NSGA-II weakness). Keep one copy of each genome; if that leaves fewer than
        # ``n`` candidates, top up with fresh random immigrants.
        unique: Dict[str, MOCandidate] = {}
        for c in combined:
            unique.setdefault(self._key(c.genome), c)
        combined = list(unique.values())
        while len(combined) < n:
            immigrant = self.evaluate(self.spec.random_genome(self.rng))
            if self._key(immigrant.genome) not in unique:
                unique[self._key(immigrant.genome)] = immigrant
                combined.append(immigrant)
        fronts = self._assign_ranks(combined)
        nxt: List[MOCandidate] = []
        for front in fronts:
            if len(nxt) + len(front) <= n:
                nxt.extend(combined[i] for i in front)
            else:
                room = n - len(nxt)
                ordered = sorted(front, key=lambda i: -combined[i].crowding)
                nxt.extend(combined[i] for i in ordered[:room])
                break
        return nxt

    # ---------------------------------------------------------------- run
    def run(self, callback: Optional[Callable[[MOGenerationRecord], None]] = None,
            should_stop: Optional[Callable[[], bool]] = None) -> ParetoResult:
        t0 = _time.perf_counter()
        n = self.cfg.population_size
        pop = [self.evaluate(g) for g in self.spec.random_population(self.rng, n, include_baseline=True)]
        baseline = self.evaluate(self.spec.baseline_genome())
        self._assign_ranks(pop)
        history: List[MOGenerationRecord] = []
        stopped = False

        def record(gen: int) -> None:
            front = [c for c in pop if c.rank == 0 and c.valid]
            F = np.array([c.vector for c in front]) if front else np.empty((0, len(self.signs)))
            valid = [c for c in pop if c.valid]
            rec = MOGenerationRecord(
                generation=gen, front_size=len(front),
                hypervolume=hypervolume_2d(F, self.reference),
                n_invalid=len(pop) - len(valid),
                objective_means={o: float(np.mean([c.objectives[o] for c in valid])) if valid else float("nan")
                                 for o in self.cfg.objectives},
                objective_best={o: (float(min(c.objectives[o] for c in valid)) if OBJECTIVES[o][0] == "min"
                                    else float(max(c.objectives[o] for c in valid))) if valid else float("nan")
                                for o in self.cfg.objectives},
                evaluations_so_far=self.evaluations, elapsed_seconds=_time.perf_counter() - t0,
            )
            history.append(rec)
            if callback:
                callback(rec)

        record(0)
        self._checkpoint(0, pop)
        for gen in range(1, self.cfg.generations + 1):
            if should_stop and should_stop():
                stopped = True
                break
            offspring = [self.evaluate(g) for g in self._offspring(pop)]
            pop = self._select_next(pop + offspring, n)
            record(gen)
            if self.cfg.checkpoint_every and gen % self.cfg.checkpoint_every == 0:
                self._checkpoint(gen, pop)

        self._assign_ranks(pop)
        front = self._dedupe([c for c in pop if c.rank == 0 and c.valid])
        result = ParetoResult(
            front=front, baseline=baseline, final_population=sorted(pop, key=lambda c: (c.rank, -c.crowding)),
            history=history, mo_config=self.cfg, base_config=self.base_config,
            reference_point=self.reference.tolist(), evaluations=self.evaluations,
            runtime_seconds=_time.perf_counter() - t0, stopped_early=stopped,
            run_dir=str(self.run_dir) if self.run_dir else None,
        )
        self._finalise(result)
        return result

    @staticmethod
    def _dedupe(front: List[MOCandidate]) -> List[MOCandidate]:
        seen, out = set(), []
        for c in front:
            key = tuple(round(v, 6) for v in c.vector)
            if key not in seen:
                seen.add(key)
                out.append(c)
        return out

    # -------------------------------------------------------- checkpoints
    def _checkpoint(self, generation: int, pop: List[MOCandidate]) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        payload = {"generation": generation, "population": [c.to_dict() for c in pop],
                   "random_state": self.rng.bit_generator.state, "mo_config": self.cfg.to_dict(),
                   "base_config": self.base_config.to_dict(), "evaluations": self.evaluations}
        with open(self.run_dir / f"generation_{generation:03d}.json", "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=_json_default)

    def _finalise(self, result: ParetoResult) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        result.front_frame().to_csv(self.run_dir / "pareto_front.csv", index=False)
        result.history_frame().to_csv(self.run_dir / "summary.csv", index=False)
