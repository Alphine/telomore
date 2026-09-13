"""Genotype x Environment (G×E) reaction-norm study (docs/ROADMAP.md
2026-09-13 follow-up to Genome Stability).

Each (genotype, environment) pair is run as an ISOLATED simulation --
``base_config.replace(**genotype.overrides, **environment.overrides)`` -- and
averaged over ``eval_seeds``, exactly like ``analysis.sensitivity``'s
one-axis sweep. Genotypes never compete against each other in a shared
population (that would be sub-clone competition, docs/MODEL.md §2.2, a
different mechanism measuring frequency-dependent dynamics rather than
classical G×E interaction). Reuses the same fitness function as every other
optimizer/analysis surface (``evolution.fitness.compute_fitness``).
"""

from __future__ import annotations

import time as _time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..evolution.fitness import FitnessBreakdown, average_breakdowns, compute_fitness
from ..schemas import GxEConfig, ModelConfig
from ..simulator.model import SimpleTelomereModel


@dataclass
class GxECell:
    """One finished (genotype, environment) cell, averaged over eval_seeds."""

    genotype: str
    environment: str
    fitness: float
    survival: float
    senescence: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class GxEResult:
    items: List[GxECell]
    base_config: ModelConfig
    gxe_config: GxEConfig
    #: Genotype-name pairs whose relative fitness ordering flips sign between
    #: at least two environments -- the textbook G×E-interaction signature.
    reranking_pairs: List[Tuple[str, str]]
    evaluations: int = 0
    runtime_seconds: float = 0.0

    def to_frame(self):
        """genotype, environment, fitness, survival, senescence -- one row per cell."""
        import pandas as pd

        rows = [
            {
                "genotype": it.genotype,
                "environment": it.environment,
                "fitness": it.fitness,
                "survival": it.survival,
                "senescence": it.senescence,
            }
            for it in self.items
        ]
        return pd.DataFrame(rows, columns=["genotype", "environment", "fitness", "survival", "senescence"])

    def to_json_dict(self) -> Dict[str, Any]:
        return {
            "base_config": self.base_config.to_dict(),
            "gxe_config": self.gxe_config.to_dict(),
            "items": [it.to_dict() for it in self.items],
            "reranking_pairs": [list(p) for p in self.reranking_pairs],
            "evaluations": self.evaluations,
            "runtime_seconds": self.runtime_seconds,
        }


def _evaluate_cell(
    model: SimpleTelomereModel, base_config: ModelConfig, genotype, environment, weights, eval_seeds,
) -> FitnessBreakdown:
    cell_config = base_config.replace(**genotype.overrides, **environment.overrides)
    breakdowns = [compute_fitness(model.simulate(cell_config.replace(seed=int(s))), weights) for s in eval_seeds]
    return average_breakdowns(breakdowns)


def _detect_reranking(
    items: List[GxECell], genotype_names: List[str], environment_names: List[str],
) -> List[Tuple[str, str]]:
    """Flag a genotype pair whose fitness-difference sign flips between at
    least two environments. Deterministic, no statistics needed -- a
    reaction-norm crossing is a sign flip, not a significance test.
    """
    by_cell = {(it.genotype, it.environment): it.fitness for it in items}
    pairs: List[Tuple[str, str]] = []
    for i, a in enumerate(genotype_names):
        for b in genotype_names[i + 1:]:
            signs = set()
            for env in environment_names:
                fa, fb = by_cell[(a, env)], by_cell[(b, env)]
                if fa != fa or fb != fb:  # NaN (invalid cell): skip, not a comparable sign
                    continue
                if fa > fb:
                    signs.add(1)
                elif fa < fb:
                    signs.add(-1)
            if len(signs) > 1:
                pairs.append((a, b))
    return pairs


def run_gxe_analysis(
    base_config: ModelConfig,
    gxe_config: GxEConfig,
    model: Optional[SimpleTelomereModel] = None,
    callback: Optional[Callable[[GxECell], None]] = None,
) -> GxEResult:
    cfg = gxe_config.validate()
    base_config = base_config.validate()
    model = model or SimpleTelomereModel()
    t0 = _time.perf_counter()
    evaluations = 0

    items: List[GxECell] = []
    for genotype in cfg.genotypes:
        for environment in cfg.environments:
            bd = _evaluate_cell(model, base_config, genotype, environment, cfg.weights, cfg.eval_seeds)
            evaluations += len(cfg.eval_seeds)
            cell = GxECell(
                genotype=genotype.name,
                environment=environment.name,
                fitness=bd.total if bd.valid else float("nan"),
                survival=bd.survival if bd.valid else float("nan"),
                senescence=bd.senescence if bd.valid else float("nan"),
            )
            items.append(cell)
            if callback:
                callback(cell)

    reranking = _detect_reranking(
        items, [g.name for g in cfg.genotypes], [e.name for e in cfg.environments]
    )
    return GxEResult(
        items=items,
        base_config=base_config,
        gxe_config=cfg,
        reranking_pairs=reranking,
        evaluations=evaluations,
        runtime_seconds=_time.perf_counter() - t0,
    )
