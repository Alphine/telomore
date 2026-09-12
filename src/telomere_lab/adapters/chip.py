"""Organ-on-a-chip condition abstraction (SDD §24).

    chip condition (flow, oxygen, nutrients, stress exposure, duration)
                              |
                              v
        abstract model parameters (stress_level, repair_rate, cycles)

**This mapping is a modelling assumption, not a calibrated relationship.**
It exists so the virtual experiment can be *framed* in terms of culture
conditions a chip operator controls. Coefficients are round numbers chosen
to keep every output inside the simulator's parameter bounds; they are not
fitted to any dataset. The app labels outputs of this module as
"derived simulation parameters".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict

import numpy as np

__all__ = [
    "ChipConditions",
    "chip_to_model_params",
    "CHIP_PRESETS",
    "list_chip_presets",
]


@dataclass
class ChipConditions:
    flow_rate: float = 0.5        # 0 = static culture, 1 = high perfusion
    oxygen_tension: float = 0.21  # fraction O2; 0.21 = atmospheric, ~0.05 = physioxia
    nutrient_state: float = 0.8   # 0 = depleted, 1 = replete
    stress_exposure: float = 0.2  # 0 = none, 1 = maximal exogenous stressor
    culture_days: float = 60.0    # duration of the virtual experiment
    #: Population-doubling time assumed for this culture, used to convert
    #: culture_days -> simulator cycles (docs/MODEL.md Sec 6.1). Defaults to
    #: the same 1.0 day every chip condition used before this field existed
    #: (fibroblast-like), so unset/custom conditions are unaffected; the
    #: named presets below override it with a literature-checked,
    #: cell-type-appropriate value instead of sharing one global constant.
    doubling_time_days: float = 1.0

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


def chip_to_model_params(chip: ChipConditions) -> Dict[str, float]:
    """Map chip conditions to ``stress_level``, ``repair_rate`` and ``cycles``.

    Assumptions (documented, not validated):

    * Atmospheric oxygen (21 %) is hyperoxic relative to tissue and adds
      oxidative stress; physioxia (~5 %) adds none. Contribution grows
      linearly between 5 % and 21 %.
    * Exogenous stress exposure adds stress one-to-one.
    * Nutrient depletion adds stress and lowers repair capacity.
    * Perfusion (flow) improves waste removal, which we model as a modest
      reduction in effective stress and a modest gain in repair capacity.
    """
    o2_stress = float(np.clip((chip.oxygen_tension - 0.05) / (0.21 - 0.05), 0.0, 1.0)) * 0.35
    exogenous = float(np.clip(chip.stress_exposure, 0.0, 1.0)) * 0.55
    nutrient_stress = (1.0 - float(np.clip(chip.nutrient_state, 0.0, 1.0))) * 0.25
    flow_relief = float(np.clip(chip.flow_rate, 0.0, 1.0)) * 0.15

    stress_level = float(np.clip(o2_stress + exogenous + nutrient_stress - flow_relief, 0.0, 1.0))
    repair_rate = float(np.clip(
        0.10 + 0.30 * chip.nutrient_state + 0.20 * chip.flow_rate, 0.0, 1.0
    ))
    cycles = int(np.clip(round(chip.culture_days / chip.doubling_time_days), 1, 1000))
    return {"stress_level": stress_level, "repair_rate": repair_rate, "cycles": cycles}


# --------------------------------------------------------------------------- #
# Named illustrative chip presets (ROADMAP.md candidate feature #3: multi-chip
# comparison). Each is a hand-picked point in the (flow, oxygen, nutrients,
# stress, duration) space loosely evoking a real organ-on-chip *concept* from
# the literature -- NOT a calibrated reproduction of any organ's physiology.
# Per docs/SCIENTIFIC_SCOPE.md, "organ-on-a-chip bridge": these names are
# framing devices for experiment-design narrative, not claims that the model
# reproduces liver/lung/gut biology. No coefficients here were fit to any
# dataset; they were chosen, like ``chip_to_model_params`` itself, to sit at
# meaningfully different points of the input space and to stay inside the
# simulator's parameter bounds.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ChipPreset:
    conditions: ChipConditions
    label: str
    description: str


CHIP_PRESETS: Dict[str, ChipPreset] = {
    # Control point: no perfusion, no deliberate stressor -- the reference
    # every other preset's "what does chip X add relative to a plain dish"
    # comparison implicitly uses.
    "static_well": ChipPreset(
        conditions=ChipConditions(
            flow_rate=0.0, oxygen_tension=0.21, nutrient_state=0.6,
            stress_exposure=0.05, culture_days=60.0,
            # Fibroblast-like doubling (~18-24h, docs/MODEL.md Sec 6.1) -- the
            # same 1.0-day value every preset used before per-preset doubling
            # times existed, kept explicit here as the "no organ framing"
            # baseline the others are compared against.
            doubling_time_days=1.0,
        ),
        label="Static well (control)",
        description="No perfusion, atmospheric oxygen, no deliberate exogenous stressor -- "
                     "an illustrative baseline dish, not an organ-chip condition.",
    ),
    # Low-flow / physioxic / high-stress axis, evoking a liver-chip's low
    # perfusion + physiological (not atmospheric) oxygen tension.
    "liver_chip_like": ChipPreset(
        conditions=ChipConditions(
            flow_rate=0.15, oxygen_tension=0.06, nutrient_state=0.5,
            stress_exposure=0.5, culture_days=90.0,
            # Primary hepatocyte / liver-organoid doubling: ~3.5-5.8 days
            # depending on passage/duration (docs/MODEL.md Sec 6.1); 4.5 is
            # the midpoint, not a single literature-reported value.
            doubling_time_days=4.5,
        ),
        label="Liver-chip-like (low flow, physioxia)",
        description="Illustrative low-perfusion, low-oxygen-tension, metabolically demanding "
                     "profile evoking a liver-chip's physioxia -- not a calibrated hepatocyte model.",
    ),
    # High-flow / high-oxygen axis, evoking a lung-chip's air-liquid interface
    # and active gas exchange.
    "lung_chip_like": ChipPreset(
        conditions=ChipConditions(
            flow_rate=0.9, oxygen_tension=0.21, nutrient_state=0.9,
            stress_exposure=0.15, culture_days=45.0,
            # Airway epithelial expansion-phase doubling (~1-2 days per
            # cell-population-doubling reports, docs/MODEL.md Sec 6.1) --
            # faster than liver/gut but still checked, not assumed; note the
            # literature also says mature, differentiated ALI epithelium
            # becomes far less proliferative than this, which this single
            # constant does not capture (same class of gap as before, just
            # smaller).
            doubling_time_days=2.0,
        ),
        label="Lung-chip-like (high flow, high O2)",
        description="Illustrative high-perfusion, atmospheric-oxygen, nutrient-replete profile "
                     "evoking a lung-chip's air-liquid interface -- not a calibrated alveolar model.",
    ),
    # Nutrient-limited axis, evoking a gut-chip's variable/limited nutrient
    # exposure relative to a well-fed culture.
    "gut_chip_like": ChipPreset(
        conditions=ChipConditions(
            flow_rate=0.45, oxygen_tension=0.08, nutrient_state=0.25,
            stress_exposure=0.35, culture_days=60.0,
            # Intestinal organoid doubling: typically ~7-10+ days to the next
            # split/maturity (docs/MODEL.md Sec 6.1); 8 is the middle of that
            # range, not a single literature-reported value.
            doubling_time_days=8.0,
        ),
        label="Gut-chip-like (nutrient-limited)",
        description="Illustrative moderate-flow, low-oxygen, nutrient-depleted profile evoking a "
                     "gut-chip's limited nutrient exposure -- not a calibrated epithelial model.",
    ),
    # High exogenous-stress axis (a toxicology/injury framing), the opposite
    # end of the stress_exposure knob from the static-well control.
    "injury_stress_chip_like": ChipPreset(
        conditions=ChipConditions(
            flow_rate=0.2, oxygen_tension=0.21, nutrient_state=0.45,
            stress_exposure=0.9, culture_days=60.0,
            # Fibroblast-like doubling (docs/MODEL.md Sec 6.1) -- this preset
            # is a toxicology/injury stress axis on a generic culture, not a
            # specific slow-dividing organ tissue, so the fibroblast default
            # is the appropriate anchor, same as static_well.
            doubling_time_days=1.0,
        ),
        label="High-stress injury-chip-like",
        description="Illustrative low-flow, high-exogenous-stress profile evoking a toxicology/"
                     "injury framing -- the highest deliberate stressor of these presets.",
    ),
}


def list_chip_presets() -> Dict[str, Dict[str, object]]:
    """``{name: {conditions, label, description}}`` for the API/frontend.

    ``conditions`` is a plain dict (``ChipConditions.to_dict()``); callers that
    also want the derived model parameters should run each through
    ``chip_to_model_params`` themselves (see ``backend/routers/meta.py``).
    """
    return {
        name: {
            "conditions": preset.conditions.to_dict(),
            "label": preset.label,
            "description": preset.description,
        }
        for name, preset in CHIP_PRESETS.items()
    }
