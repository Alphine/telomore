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


@dataclass
class ChipConditions:
    flow_rate: float = 0.5        # 0 = static culture, 1 = high perfusion
    oxygen_tension: float = 0.21  # fraction O2; 0.21 = atmospheric, ~0.05 = physioxia
    nutrient_state: float = 0.8   # 0 = depleted, 1 = replete
    stress_exposure: float = 0.2  # 0 = none, 1 = maximal exogenous stressor
    culture_days: float = 60.0    # duration of the virtual experiment

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


#: Assumed population-doubling time used to convert days -> cell cycles.
ASSUMED_DOUBLING_TIME_DAYS = 1.0


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
    cycles = int(np.clip(round(chip.culture_days / ASSUMED_DOUBLING_TIME_DAYS), 1, 1000))
    return {"stress_level": stress_level, "repair_rate": repair_rate, "cycles": cycles}
