// Organ-on-chip condition inputs (app/ui/controls.py::chip_controls).
import type { ChipConditions } from '../api/types'

// Defaults copied from ChipConditions (adapters/chip.py); slider ranges/steps
// copied from chip_controls() -- UI ranges, the adapter clips server-side.
export const CHIP_DEFAULTS: ChipConditions = {
  flow_rate: 0.5,
  oxygen_tension: 0.21,
  nutrient_state: 0.8,
  stress_exposure: 0.2,
  culture_days: 60,
}

export const CHIP_FIELDS: Array<{ key: keyof ChipConditions; label: string; min: number; max: number; step: number }> = [
  { key: 'flow_rate', label: 'Perfusion / flow (0 static → 1 high)', min: 0, max: 1, step: 0.05 },
  { key: 'oxygen_tension', label: 'Oxygen tension (fraction O₂)', min: 0.02, max: 0.21, step: 0.01 },
  { key: 'nutrient_state', label: 'Nutrient state (0 depleted → 1 replete)', min: 0, max: 1, step: 0.05 },
  { key: 'stress_exposure', label: 'Exogenous stress exposure', min: 0, max: 1, step: 0.05 },
  { key: 'culture_days', label: 'Culture duration (days, 1 doubling/day assumed)', min: 5, max: 300, step: 5 },
]
