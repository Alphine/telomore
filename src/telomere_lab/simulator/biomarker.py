"""Synthetic "biological age" biomarker score (ROADMAP.md candidate feature #5).

This module computes ONE relatable, demo-friendly number from an already
completed :class:`~telomere_lab.schemas.SimulationResult` -- it is a pure,
deterministic *re-expression* of quantities the model already reports in
``metrics.terminal_metrics`` (docs/MODEL.md §4), not a new measurement, not a
new simulation mechanism, and not anything validated against real biology.
See ``docs/SCIENTIFIC_SCOPE.md`` "Language policy": this is exactly the kind
of number that invites overclaiming ("this shows real aging"), so every
place it is surfaced (this module's own ``formula_note``/``scale_label``,
the API, the UI) must say plainly what it is and is not.

Scale
-----
``score_over_time`` / ``final_score`` sit on a **0-100 "synthetic age
index"**: 0 = fully youthful reference state (maximal survival, maximal
telomere reserve, no senescence), 100 = fully senescent/collapsed reference
state (extinct, or fully senescent with no reserve left). It is a convex
combination of three quantities the model already computes, so it inherits
their bounded, dimensionless-fraction semantics -- there is no new
free-standing "biological age" measurement here.

Formula
-------
For every already-recorded cycle ``t`` (same axis as ``SimulationResult.time``)::

    survival_t   = cumulative AUC of proliferative_count[0..t] / (carrying_capacity * t)
                   (clipped to [0, 1]; reduces to the exact terminal
                   `normalized_survival` metric at the last cycle -- same
                   integrand ``metrics.terminal_metrics`` already integrates
                   over the whole run, evaluated progressively instead of
                   only at the end)
    reserve_t    = clip((mean_shortest_per_cell[t] - senescence_threshold)
                         / (initial_length - senescence_threshold), 0, 1)
                   (identical formula to `normalized_telomere_reserve`,
                   evaluated at every cycle instead of only the last one)
    non_senesc_t = 1 - senescent_fraction[t]
                   (complement of `final_senescent_fraction`)

    vitality_t   = mean(survival_t, reserve_t, non_senesc_t)   # equal weights
    age_index_t  = 100 * (1 - vitality_t)                      # clip [0, 100]

An extinct culture at cycle ``t`` (``population_size[t] == 0``) is forced to
``age_index_t = 100`` regardless of the formula above (a culture that has
ended is, by definition, at the fully senescent/collapsed end of the scale,
even though the *cumulative* survival term can still be positive from
cycles when the culture was alive).

``final_score`` is ``score_over_time`` at the last recorded cycle, which by
construction equals the same weighted combination of the three *terminal*
metrics already named in ``metrics.terminal_metrics``
(``normalized_survival``, ``normalized_telomere_reserve``,
``final_senescent_fraction``) -- i.e. this function invents no new
underlying measurement, it only combines three numbers the model already
reports into one relatable number and tracks that combination over time.

Why these three terms (and not others)
---------------------------------------
* **Survival** -- the model's own strongest "still young and dividing"
  signal; a culture that has stopped proliferating (senescent or extinct)
  cannot look youthful under this model no matter its telomere lengths.
* **Telomere reserve** -- how much buffer remains, on average, before the
  model's own senescence trigger (`senescence_threshold`); this is the
  quantity most directly analogous to a "reserve" narrative for a
  telomere-population model.
* **Senescent fraction** -- the direct population-level readout of how much
  of the culture has already crossed into the model's terminal state.

Each is already a first-class, documented output of this model
(`docs/MODEL.md` §4); nothing here is inferred from outside the
already-computed trajectory, and no random draw is used (deterministic,
pure function of ``result``).

Explicitly NOT modelled
------------------------
This is **not** a validated biological-age clock (e.g. epigenetic /
methylation clocks), not a claim about lifespan or disease risk, and not
fit to any real dataset -- it is a documented, transparent arithmetic
function of numbers this simulation already produced. See
``docs/SCIENTIFIC_SCOPE.md``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from ..schemas import SimulationResult

#: Human-readable name of the 0-100 scale, safe to surface verbatim in the UI.
SCALE_LABEL = "synthetic age index, 0 (youthful reference) - 100 (senescent reference)"

#: Equal weights on the three terminal-metric-derived "vitality" terms (see
#: module docstring for why exactly these three and why equal weighting --
#: an explicit, changeable choice, not a fitted or biologically-derived one).
_W_SURVIVAL = 1.0 / 3.0
_W_RESERVE = 1.0 / 3.0
_W_NON_SENESCENT = 1.0 / 3.0

#: Short, machine-readable caption safe to surface as a UI tooltip/caption.
FORMULA_NOTE = (
    "age_index = 100 * (1 - mean(normalized_survival, normalized_telomere_reserve, "
    "1 - senescent_fraction)), computed at every recorded cycle from this "
    "simulation's own terminal-metric quantities (docs/MODEL.md §4); an "
    "extinct culture saturates at 100. This is an illustrative composite "
    "convenience number, not a validated biomarker or a measurement of "
    "biological age -- see docs/SCIENTIFIC_SCOPE.md."
)


@dataclass
class BiologicalAgeScore:
    """Synthetic "biological age" summary of one ``SimulationResult``.

    ``valid=False`` (with ``score_over_time`` empty and ``final_score=None``)
    is returned, never a crash or NaN, whenever the underlying result is
    itself invalid (see :func:`biological_age_score`).
    """

    score_over_time: np.ndarray = field(default_factory=lambda: np.array([], dtype=float))
    final_score: Optional[float] = None
    scale_label: str = SCALE_LABEL
    formula_note: str = FORMULA_NOTE
    valid: bool = True

    def to_json_dict(self) -> dict:
        return {
            "score_over_time": np.asarray(self.score_over_time, dtype=float).tolist(),
            "final_score": self.final_score,
            "scale_label": self.scale_label,
            "formula_note": self.formula_note,
            "valid": self.valid,
        }


def _empty_score() -> BiologicalAgeScore:
    return BiologicalAgeScore(
        score_over_time=np.array([], dtype=float),
        final_score=None,
        scale_label=SCALE_LABEL,
        formula_note=FORMULA_NOTE,
        valid=False,
    )


def biological_age_score(result: "SimulationResult") -> BiologicalAgeScore:
    """Deterministic 0-100 "synthetic age index" over an entire trajectory.

    Pure function of ``result`` (no RNG): the same ``SimulationResult`` in
    always gives the same score out. See the module docstring for the exact
    formula and its rationale. Returns an explicitly-flagged empty/invalid
    score (never raises, never NaN) when ``result.valid`` is ``False``.
    """
    if not result.valid:
        return _empty_score()

    config = result.config
    threshold = float(config.senescence_threshold)
    initial_length = float(config.initial_length)
    capacity = max(int(config.carrying_capacity), 1)

    time = np.asarray(result.time, dtype=float)
    if time.size == 0:
        return _empty_score()

    # --- survival_t: cumulative proliferative-cell AUC / (capacity * t), the
    # same integrand `metrics.terminal_metrics` integrates over the whole run,
    # evaluated progressively so it reduces to that exact terminal value at
    # the last cycle. -----------------------------------------------------
    prolif = np.nan_to_num(np.asarray(result.proliferative_count, dtype=float), nan=0.0)
    increments = np.zeros_like(time)
    if time.size > 1:
        increments[1:] = (prolif[:-1] + prolif[1:]) / 2.0 * np.diff(time)
    cum_auc = np.cumsum(increments)
    denom = np.maximum(capacity * np.maximum(time, 1.0), 1.0)
    survival_t = np.clip(cum_auc / denom, 0.0, 1.0)
    survival_t[0] = np.clip(prolif[0] / capacity, 0.0, 1.0)  # t=0: instantaneous, AUC is ill-defined

    # --- reserve_t: identical formula to `normalized_telomere_reserve`,
    # evaluated at every cycle. --------------------------------------------
    shortest = np.asarray(result.mean_shortest_per_cell, dtype=float)
    shortest = np.nan_to_num(shortest, nan=0.0)
    reserve_t = np.clip((shortest - threshold) / max(initial_length - threshold, 1.0), 0.0, 1.0)

    # --- non_senescent_t: complement of `final_senescent_fraction`. -------
    sen = np.asarray(result.senescent_fraction, dtype=float)
    non_senescent_t = np.where(np.isnan(sen), 0.0, 1.0 - sen)

    vitality_t = _W_SURVIVAL * survival_t + _W_RESERVE * reserve_t + _W_NON_SENESCENT * non_senescent_t
    age_t = 100.0 * (1.0 - vitality_t)

    pop = np.asarray(result.population_size, dtype=float)
    extinct_t = pop <= 0
    age_t = np.where(extinct_t, 100.0, age_t)
    age_t = np.clip(age_t, 0.0, 100.0).astype(float)

    return BiologicalAgeScore(
        score_over_time=age_t,
        final_score=float(age_t[-1]),
        scale_label=SCALE_LABEL,
        formula_note=FORMULA_NOTE,
        valid=True,
    )
