// Non-component helpers for the Evolve page (kept out of index.tsx so fast
// refresh sees a components-only module).
import type { EvolutionConfig, FitnessWeights } from '../../api/types'

// Copied verbatim from app/ui/controls.py::fitness_weight_controls.
export const FITNESS_FORMULA = 'fitness = w₁·survival + w₂·reserve − w₃·senescence − w₄·instability − w₅·cost'

export const WEIGHT_FIELDS: Array<{ key: keyof FitnessWeights; label: string }> = [
  { key: 'w_survival', label: 'w₁ survival' },
  { key: 'w_reserve', label: 'w₂ telomere reserve' },
  { key: 'w_senescence', label: 'w₃ senescence' },
  { key: 'w_instability', label: 'w₄ instability' },
  { key: 'w_cost', label: 'w₅ intervention cost' },
]

/** Form state: EvolutionConfig with eval_seeds kept as the raw comma-separated text. */
export interface EvoForm extends Omit<EvolutionConfig, 'eval_seeds' | 'weights'> {
  eval_seeds_text: string
}

export function toForm(cfg: EvolutionConfig): EvoForm {
  const { eval_seeds, weights: _weights, ...rest } = cfg
  return { ...rest, eval_seeds_text: eval_seeds.join(',') }
}

/** Same parsing as evolution_controls(): comma-separated ints, blanks ignored. */
export function parseSeeds(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const seeds = parts.map((s) => Number(s))
  if (seeds.some((n) => !Number.isInteger(n))) return null
  return seeds
}

export function signed(v: number, digits = 3): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`
}
