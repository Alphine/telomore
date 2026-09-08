"""Parameter genome (SDD §12).

A genome is a small dictionary of *free* model parameters. Every gene knows
its valid domain, and all genetic operators work in a normalised [0, 1]
space so a single ``mutation_sigma`` is meaningful across genes with very
different physical units.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence

import numpy as np

from ..schemas import EVOLVABLE_PARAMETERS, PARAMETER_BOUNDS, ModelConfig


@dataclass(frozen=True)
class Gene:
    name: str
    minimum: float
    maximum: float
    mutation_sigma: float = 0.15  # in normalised units

    @property
    def span(self) -> float:
        return self.maximum - self.minimum

    def clip(self, value: float) -> float:
        return float(min(max(value, self.minimum), self.maximum))

    def normalise(self, value: float) -> float:
        return (self.clip(value) - self.minimum) / self.span if self.span > 0 else 0.0

    def denormalise(self, unit: float) -> float:
        return self.clip(self.minimum + float(np.clip(unit, 0.0, 1.0)) * self.span)


class GenomeSpec:
    """Ordered collection of genes plus the fixed base configuration."""

    def __init__(self, base_config: ModelConfig, free_genes: Sequence[str],
                 mutation_sigma: float = 0.15):
        for g in free_genes:
            if g not in EVOLVABLE_PARAMETERS:
                raise ValueError(f"{g} is not evolvable")
        self.base_config = base_config
        self.genes: List[Gene] = []
        for name in free_genes:
            lo, hi = PARAMETER_BOUNDS[name][0], PARAMETER_BOUNDS[name][1]
            # Keep the threshold strictly below the initial length at both ends
            # of its range so any genome maps to a valid ModelConfig.
            if name == "senescence_threshold":
                hi = min(hi, base_config.initial_length * 0.8) if "initial_length" not in free_genes \
                    else min(hi, PARAMETER_BOUNDS["initial_length"][0] * 0.8)
            self.genes.append(Gene(name, lo, hi, mutation_sigma))

    @property
    def names(self) -> List[str]:
        return [g.name for g in self.genes]

    def __len__(self) -> int:
        return len(self.genes)

    # --- conversions ---------------------------------------------------------
    def to_array(self, genome: Dict[str, float]) -> np.ndarray:
        return np.array([g.normalise(genome[g.name]) for g in self.genes])

    def from_array(self, arr: np.ndarray) -> Dict[str, float]:
        return {g.name: g.denormalise(u) for g, u in zip(self.genes, arr)}

    def repair(self, genome: Dict[str, float]) -> Dict[str, float]:
        """Clip every gene into its domain (SDD §14 step 8)."""
        return {g.name: g.clip(genome[g.name]) for g in self.genes}

    def to_config(self, genome: Dict[str, float], seed: int | None = None) -> ModelConfig:
        changes = dict(self.repair(genome))
        if seed is not None:
            changes["seed"] = seed
        return self.base_config.replace(**changes)

    def baseline_genome(self) -> Dict[str, float]:
        return {g.name: g.clip(getattr(self.base_config, g.name)) for g in self.genes}

    # --- initialisation --------------------------------------------------------
    def random_genome(self, rng: np.random.Generator) -> Dict[str, float]:
        return self.from_array(rng.random(len(self.genes)))

    def random_population(self, rng: np.random.Generator, n: int,
                          include_baseline: bool = True) -> List[Dict[str, float]]:
        pop = [self.random_genome(rng) for _ in range(n)]
        if include_baseline and n > 0:
            pop[0] = self.baseline_genome()
        return pop

    def diversity(self, population: Iterable[Dict[str, float]]) -> float:
        """Mean per-gene standard deviation in normalised space."""
        arr = np.array([self.to_array(g) for g in population])
        if arr.size == 0:
            return 0.0
        return float(arr.std(axis=0).mean())
