"""One-at-a-time (OAT) sensitivity analysis (tornado chart).

For each evolvable parameter, perturb it by +/- ``perturbation_fraction`` of
its ``PARAMETER_BOUNDS`` range while holding every other parameter at the
baseline ``ModelConfig``, average fitness over ``eval_seeds``, and record the
resulting swing (high - low). Reuses the same fitness function as the
evolutionary optimizer (``evolution.fitness.compute_fitness``) so sensitivity
and evolution always agree on what "fitness" means.
"""

from __future__ import annotations

import time as _time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, List, Optional

from ..evolution.fitness import FitnessBreakdown, average_breakdowns, compute_fitness
from ..schemas import PARAMETER_BOUNDS, ModelConfig, SensitivityConfig
from ..simulator.model import SimpleTelomereModel


@dataclass
class ParameterSensitivity:
    parameter: str
    baseline_value: float
    low_value: float
    high_value: float
    fitness_low: float
    fitness_baseline: float
    fitness_high: float

    @property
    def swing(self) -> float:
        return self.fitness_high - self.fitness_low

    def to_dict(self) -> Dict[str, float]:
        d = asdict(self)
        d["swing"] = self.swing
        return d


@dataclass
class SensitivityResult:
    baseline_fitness: float
    items: List[ParameterSensitivity]
    base_config: ModelConfig
    sensitivity_config: SensitivityConfig
    evaluations: int = 0
    runtime_seconds: float = 0.0

    def to_frame(self):
        """Parameter, fitness_low/baseline/high, swing — sorted by |swing| desc."""
        import pandas as pd

        rows = [
            {
                "parameter": it.parameter,
                "fitness_low": it.fitness_low,
                "fitness_baseline": it.fitness_baseline,
                "fitness_high": it.fitness_high,
                "swing": it.swing,
            }
            for it in self.items
        ]
        df = pd.DataFrame(rows, columns=["parameter", "fitness_low", "fitness_baseline", "fitness_high", "swing"])
        if df.empty:
            return df
        order = df["swing"].abs().sort_values(ascending=False).index
        return df.reindex(order).reset_index(drop=True)

    def to_json_dict(self) -> Dict[str, Any]:
        return {
            "base_config": self.base_config.to_dict(),
            "sensitivity_config": self.sensitivity_config.to_dict(),
            "baseline_fitness": self.baseline_fitness,
            "items": [it.to_dict() for it in self.items],
            "evaluations": self.evaluations,
            "runtime_seconds": self.runtime_seconds,
        }


def _evaluate(model: SimpleTelomereModel, config: ModelConfig, weights, eval_seeds) -> FitnessBreakdown:
    breakdowns = [compute_fitness(model.simulate(config.replace(seed=int(s))), weights) for s in eval_seeds]
    return average_breakdowns(breakdowns)


def run_sensitivity_analysis(
    base_config: ModelConfig,
    sensitivity_config: SensitivityConfig,
    model: Optional[SimpleTelomereModel] = None,
    callback: Optional[Callable[[ParameterSensitivity], None]] = None,
) -> SensitivityResult:
    cfg = sensitivity_config.validate()
    base_config = base_config.validate()
    model = model or SimpleTelomereModel()
    t0 = _time.perf_counter()
    evaluations = 0

    baseline_bd = _evaluate(model, base_config, cfg.weights, cfg.eval_seeds)
    evaluations += len(cfg.eval_seeds)
    baseline_fitness = baseline_bd.total if baseline_bd.valid else float("nan")

    items: List[ParameterSensitivity] = []
    for name in cfg.parameters:
        lo_bound, hi_bound = PARAMETER_BOUNDS[name][0], PARAMETER_BOUNDS[name][1]
        span = hi_bound - lo_bound
        delta = cfg.perturbation_fraction * span
        baseline_value = float(getattr(base_config, name))
        low_value = max(lo_bound, baseline_value - delta)
        high_value = min(hi_bound, baseline_value + delta)
        # Keep senescence_threshold strictly below initial_length so the
        # perturbed config is always valid (ModelConfig.validate, SDD §9).
        if name == "senescence_threshold":
            cap = base_config.initial_length * 0.999
            low_value, high_value = min(low_value, cap), min(high_value, cap)
        elif name == "initial_length":
            floor = base_config.senescence_threshold / 0.999
            low_value, high_value = max(low_value, floor), max(high_value, floor)

        low_bd = _evaluate(model, base_config.replace(**{name: low_value}), cfg.weights, cfg.eval_seeds)
        high_bd = _evaluate(model, base_config.replace(**{name: high_value}), cfg.weights, cfg.eval_seeds)
        evaluations += 2 * len(cfg.eval_seeds)

        item = ParameterSensitivity(
            parameter=name,
            baseline_value=baseline_value,
            low_value=low_value,
            high_value=high_value,
            fitness_low=low_bd.total if low_bd.valid else float("nan"),
            fitness_baseline=baseline_fitness,
            fitness_high=high_bd.total if high_bd.valid else float("nan"),
        )
        items.append(item)
        if callback:
            callback(item)

    return SensitivityResult(
        baseline_fitness=baseline_fitness,
        items=items,
        base_config=base_config,
        sensitivity_config=cfg,
        evaluations=evaluations,
        runtime_seconds=_time.perf_counter() - t0,
    )
