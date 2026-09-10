"""Parameter genome (SDD §12).

A genome is a small dictionary of *free* model parameters. Every gene knows
its valid domain, and all genetic operators work in a normalised [0, 1]
space so a single ``mutation_sigma`` is meaningful across genes with very
different physical units.

Protocol search (docs/MODEL.md §2.1): with ``schedule_phases > 1`` every free
gene in ``SCHEDULABLE_PARAMETERS`` is expanded into one gene per phase, named
``"<parameter>@<phase>"`` (e.g. ``maintenance_rate@3``) with the parameter's
own bounds. Decoding assembles those genes into an ``InterventionSchedule``
on the candidate ``ModelConfig``; the scalar field is set to the phase-0
value so it keeps its documented "fallback" meaning. With
``schedule_phases == 1`` the genome is exactly the classic constant-gene
genome and no schedule is created.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence

import numpy as np

from ..schemas import (
    EVOLVABLE_PARAMETERS,
    MAX_PHASES,
    PARAMETER_BOUNDS,
    SCHEDULABLE_PARAMETERS,
    InterventionSchedule,
    ModelConfig,
)

PHASE_SEPARATOR = "@"


def split_gene_name(gene_name: str) -> tuple[str, int | None]:
    """``"maintenance_rate@3" -> ("maintenance_rate", 3)``; ``"stress_level" -> ("stress_level", None)``."""
    if PHASE_SEPARATOR in gene_name:
        base, _, phase = gene_name.rpartition(PHASE_SEPARATOR)
        return base, int(phase)
    return gene_name, None


@dataclass(frozen=True)
class Gene:
    name: str
    minimum: float
    maximum: float
    mutation_sigma: float = 0.15  # in normalised units

    @property
    def parameter(self) -> str:
        """The ``ModelConfig`` field this gene maps to (phase suffix stripped)."""
        return split_gene_name(self.name)[0]

    @property
    def phase(self) -> int | None:
        return split_gene_name(self.name)[1]

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
                 mutation_sigma: float = 0.15, schedule_phases: int = 1):
        for g in free_genes:
            if g not in EVOLVABLE_PARAMETERS:
                raise ValueError(f"{g} is not evolvable")
        if not (1 <= int(schedule_phases) <= MAX_PHASES):
            raise ValueError(f"schedule_phases must be in [1, {MAX_PHASES}], got {schedule_phases}")
        self.base_config = base_config
        self.free_genes = tuple(free_genes)
        self.schedule_phases = int(schedule_phases)
        base_schedule = base_config.schedule
        if (self.schedule_phases > 1 and base_schedule is not None
                and base_schedule.phases != self.schedule_phases
                and any(k not in self.scheduled_parameters for k in base_schedule.values)):
            raise ValueError(
                f"base_config schedule has {base_schedule.phases} phases but schedule_phases="
                f"{self.schedule_phases}; a locked scheduled parameter cannot be re-phased"
            )
        self.genes: List[Gene] = []
        for name in free_genes:
            lo, hi = PARAMETER_BOUNDS[name][0], PARAMETER_BOUNDS[name][1]
            # Keep the threshold strictly below the initial length at both ends
            # of its range so any genome maps to a valid ModelConfig.
            if name == "senescence_threshold":
                hi = min(hi, base_config.initial_length * 0.8) if "initial_length" not in free_genes \
                    else min(hi, PARAMETER_BOUNDS["initial_length"][0] * 0.8)
            if name in self.scheduled_parameters:
                for k in range(self.schedule_phases):
                    self.genes.append(Gene(f"{name}{PHASE_SEPARATOR}{k}", lo, hi, mutation_sigma))
            else:
                self.genes.append(Gene(name, lo, hi, mutation_sigma))

    @property
    def scheduled_parameters(self) -> tuple:
        """Free genes that are expanded per phase (empty when ``schedule_phases == 1``)."""
        if self.schedule_phases <= 1:
            return ()
        return tuple(g for g in self.free_genes if g in SCHEDULABLE_PARAMETERS)

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
        genome = self.repair(genome)
        changes: Dict[str, object] = {}
        phase_values: Dict[str, List[float]] = {}
        for gene in self.genes:
            if gene.phase is None:
                changes[gene.name] = genome[gene.name]
            else:
                phase_values.setdefault(gene.parameter, [0.0] * self.schedule_phases)[gene.phase] = genome[gene.name]
        if seed is not None:
            changes["seed"] = seed

        base_schedule = self.base_config.schedule
        if phase_values:
            values: Dict[str, tuple] = {}
            if base_schedule is not None and base_schedule.phases == self.schedule_phases:
                values.update(base_schedule.values)  # locked scheduled parameters pass through
            for name, vals in phase_values.items():
                values[name] = tuple(float(v) for v in vals)
                changes[name] = values[name][0]  # scalar field documents the phase-0 value
            changes["schedule"] = InterventionSchedule(phases=self.schedule_phases, values=values)
        elif base_schedule is not None:
            # Constant free genes supersede any schedule the base config had for them;
            # schedules on locked parameters pass through unchanged.
            kept = {k: v for k, v in base_schedule.values.items() if k not in changes}
            changes["schedule"] = (InterventionSchedule(phases=base_schedule.phases, values=kept)
                                   if kept else None)
        return self.base_config.replace(**changes)

    def baseline_genome(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for g in self.genes:
            if g.phase is None:
                out[g.name] = g.clip(getattr(self.base_config, g.name))
            else:
                out[g.name] = g.clip(self._base_phase_value(g.parameter, g.phase))
        return out

    def _base_phase_value(self, name: str, phase: int) -> float:
        sched = self.base_config.schedule
        if sched is not None and name in sched.values and sched.phases == self.schedule_phases:
            return float(sched.values[name][phase])
        return float(getattr(self.base_config, name))

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
