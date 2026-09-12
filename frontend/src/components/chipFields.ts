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
  doubling_time_days: 1,
}

export const CHIP_FIELDS: Array<{ key: keyof ChipConditions; label: string; min: number; max: number; step: number }> = [
  { key: 'flow_rate', label: 'Perfusion / flow (0 static → 1 high)', min: 0, max: 1, step: 0.05 },
  { key: 'oxygen_tension', label: 'Oxygen tension (fraction O₂)', min: 0.02, max: 0.21, step: 0.01 },
  { key: 'nutrient_state', label: 'Nutrient state (0 depleted → 1 replete)', min: 0, max: 1, step: 0.05 },
  { key: 'stress_exposure', label: 'Exogenous stress exposure', min: 0, max: 1, step: 0.05 },
  { key: 'culture_days', label: 'Culture duration (days)', min: 5, max: 300, step: 5 },
  // Default 1 day = fibroblast-like (docs/MODEL.md Sec 6.1); the named chip
  // presets override this per cell type (e.g. liver-chip-like ~4.5 days).
  { key: 'doubling_time_days', label: 'Assumed doubling time (days/cycle)', min: 0.5, max: 10, step: 0.5 },
]
