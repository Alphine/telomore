"""Surrogate-model active learning: a genuinely different optimizer.

GA / NSGA-II / random search (``evolution/benchmark.py``) all pay one real
simulator call per candidate. This module instead fits a cheap regression
**surrogate** on the (genome, fitness) pairs already evaluated for real, and
uses it to decide which untested genome is most worth spending the next real
evaluation on -- classic Bayesian-optimisation-style active learning. The
question this answers, distinct from "does evolution beat random search?"
(``scripts/benchmark_optimizers.py``), is "can we reach a comparable fitness
with *fewer* real simulator evaluations by being selective about which ones
to run?"

Surrogate choice: ``sklearn.gaussian_process.GaussianProcessRegressor`` with
a Matern kernel over the same normalised [0, 1] gene space as the GA/NSGA-II
(``GenomeSpec``). A Gaussian Process is preferred here because the free-gene
space is low-dimensional (3-6 genes, ``EVOLVABLE_PARAMETERS``) and the real
-evaluation budget is small (tens of points) -- exactly the regime where a
GP is fast to fit and gives a calibrated predictive mean *and* uncertainty,
which the acquisition function below needs. A Random Forest with variance
-across-trees would be a reasonable fallback in higher dimensions or with a
much larger budget, but is not necessary at this scale.

Acquisition function: Expected Improvement (EI), the standard choice for
single-objective Bayesian optimisation -- it balances exploiting genomes the
surrogate believes are good against exploring genomes it is uncertain about.
Each iteration scores a random pool of candidate genomes with the fitted
surrogate, evaluates the EI-maximising one with the *real* simulator, and
refits. The random initial design (uniform, same ``GenomeSpec``) gives the
surrogate enough spread to fit a first GP before any acquisition step.
"""

from __future__ import annotations

import time as _time
from dataclasses import asdict, dataclass, field
from typing import Callable, Dict, List, Optional

import numpy as np
from scipy.stats import norm

from ..schemas import ActiveLearningConfig, ModelConfig
from ..simulator.model import SimpleTelomereModel
from .fitness import INVALID_FITNESS, average_breakdowns, compute_fitness
from .genome import GenomeSpec


@dataclass
class ActiveLearningRecord:
    """One real-simulator evaluation, in the order it was performed."""

    iteration: int
    phase: str                          # "initial" | "active"
    genome: Dict[str, float]
    real_fitness: float
    #: Surrogate's belief about this genome *before* it was evaluated for
    #: real. ``None`` during the initial random design (no surrogate yet).
    predicted_mean: Optional[float]
    predicted_std: Optional[float]
    acquisition_value: Optional[float]
    best_so_far: float
    n_real_evaluations: int

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


@dataclass
class ActiveLearningResult:
    records: List[ActiveLearningRecord]
    best_genome: Dict[str, float]
    best_fitness: float
    base_config: ModelConfig
    al_config: ActiveLearningConfig
    evaluations: int
    runtime_seconds: float

    def to_frame(self):
        """Per-iteration record, including surrogate prediction vs. real fitness."""
        import pandas as pd

        rows = []
        for r in self.records:
            row = {
                "iteration": r.iteration,
                "phase": r.phase,
                "real_fitness": r.real_fitness,
                "predicted_mean": r.predicted_mean,
                "predicted_std": r.predicted_std,
                "acquisition_value": r.acquisition_value,
                "best_so_far": r.best_so_far,
                "n_real_evaluations": r.n_real_evaluations,
            }
            row.update({f"gene_{k}": v for k, v in r.genome.items()})
            rows.append(row)
        return pd.DataFrame(rows)

    def convergence_frame(self):
        """(method, n_evaluations, best_fitness_so_far) -- same shape as
        ``evolution.benchmark.BenchmarkResult.to_frame()`` for shared charting."""
        import pandas as pd

        return pd.DataFrame({
            "method": "Active Learning (GP-EI)",
            "n_evaluations": [r.n_real_evaluations for r in self.records],
            "best_fitness_so_far": [r.best_so_far for r in self.records],
        })

    def to_json_dict(self) -> Dict[str, object]:
        return {
            "base_config": self.base_config.to_dict(),
            "active_learning_config": self.al_config.to_dict(),
            "best_genome": self.best_genome,
            "best_fitness": self.best_fitness,
            "evaluations": self.evaluations,
            "runtime_seconds": self.runtime_seconds,
            "records": [r.to_dict() for r in self.records],
        }


def _expected_improvement(mean: np.ndarray, std: np.ndarray, best: float, xi: float) -> np.ndarray:
    std = np.maximum(std, 1e-9)
    improvement = mean - best - xi
    z = improvement / std
    ei = improvement * norm.cdf(z) + std * norm.pdf(z)
    return np.where(std > 1e-9, ei, 0.0)


class SurrogateActiveLearner:
    """Random initial design + GP-surrogate/Expected-Improvement active learning loop."""

    def __init__(
        self,
        base_config: ModelConfig,
        al_config: ActiveLearningConfig,
        model: Optional[SimpleTelomereModel] = None,
    ):
        self.base_config = base_config.validate()
        self.cfg = al_config.validate()
        self.model = model or SimpleTelomereModel()
        self.spec = GenomeSpec(self.base_config, self.cfg.free_genes)
        self.rng = np.random.default_rng(self.cfg.seed)
        self.evaluations = 0

    # ------------------------------------------------------------------ eval
    def _evaluate_real(self, genome: Dict[str, float]) -> float:
        genome = self.spec.repair(genome)
        breakdowns = [
            compute_fitness(self.model.simulate(self.spec.to_config(genome, seed=int(s))), self.cfg.weights)
            for s in self.cfg.eval_seeds
        ]
        self.evaluations += len(self.cfg.eval_seeds)
        bd = average_breakdowns(breakdowns)
        return bd.total if bd.valid else INVALID_FITNESS

    def _fit_surrogate(self, X: np.ndarray, y: np.ndarray):
        from sklearn.gaussian_process import GaussianProcessRegressor
        from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

        kernel = ConstantKernel(1.0, (1e-2, 1e3)) * Matern(length_scale=1.0, nu=2.5) \
            + WhiteKernel(1e-3, (1e-6, 1.0))
        gp = GaussianProcessRegressor(
            kernel=kernel, normalize_y=True, n_restarts_optimizer=2,
            random_state=int(self.rng.integers(0, 2**31 - 1)),
        )
        gp.fit(X, y)
        return gp

    # ------------------------------------------------------------------ run
    def run(self, callback: Optional[Callable[[ActiveLearningRecord], None]] = None) -> ActiveLearningResult:
        t0 = _time.perf_counter()
        cfg = self.cfg
        records: List[ActiveLearningRecord] = []
        X: List[np.ndarray] = []
        y: List[float] = []
        best_fitness = -np.inf
        best_genome: Dict[str, float] = {}

        # --- initial design: uniform random over the normalised gene space ---
        for i in range(cfg.n_initial):
            genome = self.spec.random_genome(self.rng)
            fitness = self._evaluate_real(genome)
            X.append(self.spec.to_array(genome))
            y.append(fitness)
            if fitness > best_fitness:
                best_fitness, best_genome = fitness, dict(genome)
            rec = ActiveLearningRecord(
                iteration=i, phase="initial", genome=dict(genome), real_fitness=fitness,
                predicted_mean=None, predicted_std=None, acquisition_value=None,
                best_so_far=float(best_fitness), n_real_evaluations=self.evaluations,
            )
            records.append(rec)
            if callback:
                callback(rec)

        # --- active learning: fit surrogate, pick by Expected Improvement, evaluate for real ---
        for i in range(cfg.n_iterations):
            gp = self._fit_surrogate(np.array(X), np.array(y))

            candidates = self.rng.random((cfg.candidate_pool_size, len(self.spec)))
            mean, std = gp.predict(candidates, return_std=True)
            ei = _expected_improvement(mean, std, best_fitness, cfg.xi)
            chosen = int(np.argmax(ei))
            chosen_unit = candidates[chosen]
            genome = self.spec.from_array(chosen_unit)

            fitness = self._evaluate_real(genome)
            X.append(chosen_unit)
            y.append(fitness)
            if fitness > best_fitness:
                best_fitness, best_genome = fitness, dict(genome)

            rec = ActiveLearningRecord(
                iteration=cfg.n_initial + i, phase="active", genome=dict(genome), real_fitness=fitness,
                predicted_mean=float(mean[chosen]), predicted_std=float(std[chosen]),
                acquisition_value=float(ei[chosen]), best_so_far=float(best_fitness),
                n_real_evaluations=self.evaluations,
            )
            records.append(rec)
            if callback:
                callback(rec)

        return ActiveLearningResult(
            records=records, best_genome=best_genome, best_fitness=float(best_fitness),
            base_config=self.base_config, al_config=cfg, evaluations=self.evaluations,
            runtime_seconds=_time.perf_counter() - t0,
        )


def run_active_learning(
    base_config: ModelConfig,
    al_config: ActiveLearningConfig,
    model: Optional[SimpleTelomereModel] = None,
    callback: Optional[Callable[[ActiveLearningRecord], None]] = None,
) -> ActiveLearningResult:
    return SurrogateActiveLearner(base_config, al_config, model=model).run(callback=callback)
