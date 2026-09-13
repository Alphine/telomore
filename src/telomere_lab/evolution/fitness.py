"""Explicit, configurable fitness function (SDD §13).

    fitness = w_survival    * normalized_survival
            + w_reserve     * normalized_telomere_reserve
            - w_senescence  * final_senescent_fraction
            - w_instability * instability
            - w_cost        * intervention_cost
            - w_genome_instability * genomic_instability_index
            + w_canalization * canalization

* ``instability``      = final coefficient of variation of telomere lengths,
                         scaled so CV = 0.5 -> 1.0 (clipped to [0, 1]).
* ``intervention_cost``= ½ (maintenance_rate² + repair_rate²). Both are
                         "interventions" in the organ-on-chip framing and are
                         assumed to carry a *convex* cost (marginal cost grows
                         with intensity), so the optimiser has to find "just
                         enough" rather than maxing every knob. Reducing
                         ``stress_level`` is treated as free unless the user
                         reweights.
* ``genomic_instability_index`` = fraction of surviving cells whose mutation
                         burden exceeds ``mutation_threshold`` at the final
                         cycle (docs/MODEL.md §2.3). ``w_genome_instability``
                         defaults to 0.0, so this term is inert unless a user
                         opts into genome stability.
* ``canalization``     = consistency of ``survival`` across ``eval_seeds``
                         replicates: ``1 - clip(CV / 0.5, 0, 1)`` where CV is
                         the coefficient of variation of survival across
                         seeds (0 when every seed's survival is 0). Unlike
                         every other term above, this is only meaningful for
                         a REPLICATE SET, not a single simulation --
                         ``compute_fitness`` always returns ``0.0`` for it;
                         only ``average_breakdowns`` computes the real value
                         and folds ``w_canalization * canalization`` into
                         ``total`` (added, not subtracted, since higher
                         canalization is better). With a single eval seed it
                         is trivially 1.0 for every genome (docs/MODEL.md §5).

Fitness is an optimisation objective chosen by the experimenter. It is
**not** a measure of biological truth (see docs/SCIENTIFIC_SCOPE.md).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict

import numpy as np

from ..schemas import FitnessWeights, ModelConfig, SimulationResult

#: Fitness assigned to invalid simulations (SDD §30).
INVALID_FITNESS = -1.0e3
INSTABILITY_CV_SCALE = 0.5
#: Same convention/value as INSTABILITY_CV_SCALE: a coefficient of variation
#: of 0.5 (50% relative variation in survival across eval_seeds) maps to the
#: worst canalization score (0.0). Empirically, comfortable large-population
#: configs show survival CV ~= 0.7-2%, while near-extinction configs show
#: CV ~= 50%+ -- this scale meaningfully discriminates between them.
CANALIZATION_CV_SCALE = 0.5


@dataclass
class FitnessBreakdown:
    total: float
    survival: float
    reserve: float
    senescence: float
    instability: float
    cost: float
    #: Must match the ``OBJECTIVES["genome_instability"]`` key exactly --
    #: ``evolution/multiobjective.py`` reads it via ``getattr(bd, o)``.
    genome_instability: float
    #: Consistency of ``survival`` across eval_seeds replicates (docs/MODEL.md
    #: §5). Always 0.0 from ``compute_fitness`` -- undefined for a single
    #: simulation -- only ``average_breakdowns`` computes the real value
    #: across the replicate set. Must match ``OBJECTIVES["canalization"]``.
    canalization: float
    valid: bool
    reason: str | None = None

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


def intervention_cost(config: ModelConfig) -> float:
    """½(m̄² + r̄²) with m̄, r̄ the *time-averaged* maintenance / repair.

    For an unscheduled config the time average is the scalar field, so this
    is exactly the original ½(maintenance² + repair²). For a scheduled
    protocol (docs/MODEL.md §2.1) the cost is charged on the mean dose over
    the run, so intervening only part of the time is cheaper than the same
    intensity held constant.
    """
    m = config.mean_value("maintenance_rate")
    r = config.mean_value("repair_rate")
    return 0.5 * (m ** 2 + r ** 2)


def compute_fitness(result: SimulationResult, weights: FitnessWeights) -> FitnessBreakdown:
    if not result.valid or not result.terminal_metrics:
        return FitnessBreakdown(
            total=INVALID_FITNESS, survival=0.0, reserve=0.0, senescence=1.0,
            instability=1.0, cost=1.0, genome_instability=1.0, canalization=0.0,
            valid=False, reason=result.failure_reason or "invalid simulation",
        )
    tm = result.terminal_metrics
    survival = float(tm["normalized_survival"])
    reserve = float(tm["normalized_telomere_reserve"])
    senescence = float(tm["final_senescent_fraction"])
    instability = float(np.clip(tm["final_length_cv"] / INSTABILITY_CV_SCALE, 0.0, 1.0))
    cost = intervention_cost(result.config)
    genome_instability = float(tm.get("genomic_instability_index", 0.0))

    total = (
        weights.w_survival * survival
        + weights.w_reserve * reserve
        - weights.w_senescence * senescence
        - weights.w_instability * instability
        - weights.w_cost * cost
        - weights.w_genome_instability * genome_instability
    )
    if not np.isfinite(total):
        return FitnessBreakdown(INVALID_FITNESS, survival, reserve, senescence, instability,
                                cost, genome_instability, 0.0, valid=False, reason="non-finite fitness")
    return FitnessBreakdown(float(total), survival, reserve, senescence, instability, cost,
                            genome_instability, 0.0, True)


def average_breakdowns(items: list, weights: FitnessWeights) -> FitnessBreakdown:
    """Average replicate evaluations; any invalid replicate invalidates the whole.

    ``canalization`` (consistency of ``survival`` across the replicate set) is
    only defined here, not in ``compute_fitness`` -- see the module docstring.
    """
    if any(not b.valid for b in items):
        bad = next(b for b in items if not b.valid)
        return bad
    n = len(items)
    survivals = np.array([b.survival for b in items], dtype=float)
    mean_survival = float(survivals.mean())
    cv = float(survivals.std() / mean_survival) if mean_survival > 0 else 0.0
    canalization = float(1.0 - np.clip(cv / CANALIZATION_CV_SCALE, 0.0, 1.0))
    avg_total = sum(b.total for b in items) / n
    return FitnessBreakdown(
        total=avg_total + weights.w_canalization * canalization,
        survival=sum(b.survival for b in items) / n,
        reserve=sum(b.reserve for b in items) / n,
        senescence=sum(b.senescence for b in items) / n,
        instability=sum(b.instability for b in items) / n,
        cost=sum(b.cost for b in items) / n,
        genome_instability=sum(b.genome_instability for b in items) / n,
        canalization=canalization,
        valid=True,
    )
