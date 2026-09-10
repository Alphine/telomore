// Non-component helpers for the Pareto page.
import type { MOCandidate, MultiObjectiveConfig } from '../../api/types'

/**
 * Form state for the MultiObjectiveConfig controls. Initial values are the
 * dataclass defaults of telomere_lab.schemas.MultiObjectiveConfig (the
 * Streamlit page started from `MultiObjectiveConfig(weights=weights())`);
 * GET /api/meta/bounds carries no multiobjective_default block, and the API
 * fills any field left out with the same defaults server-side.
 */
export interface ParetoForm extends Omit<MultiObjectiveConfig, 'eval_seeds' | 'weights' | 'checkpoint_every'> {
  eval_seeds_text: string
}

export const PARETO_DEFAULTS: ParetoForm = {
  population_size: 40,
  generations: 25,
  mutation_rate: 0.3,
  mutation_sigma: 0.15,
  crossover_rate: 0.8,
  crossover_kind: 'uniform',
  seed: 7,
  eval_seeds_text: '42',
  free_genes: ['stress_level', 'maintenance_rate', 'repair_rate'],
  objectives: ['survival', 'cost'],
  schedule_phases: 1,
}

export const WHY_NSGA2 =
  'The GA on the Evolve page needs weights to collapse five outcomes into one number, and the winner moves when the weights move. NSGA-II keeps every candidate that is not beaten on all objectives at once — the Pareto front — so the trade-off itself becomes the result. Pick the point that matches your experimental priorities afterwards.'

/** Front-table columns: scalar fitness, the objectives, the free genes, crowding (ParetoResult.front_frame). */
export function frontColumns(front: MOCandidate[], objectives: string[]): string[] {
  const genes = front.length ? Object.keys(front[0].genome) : []
  return ['scalar_fitness', ...objectives, ...genes, 'crowding']
}

export function frontRow(c: MOCandidate): Record<string, number | null> {
  return { scalar_fitness: c.scalar_fitness, ...c.objectives, ...c.genome, crowding: c.crowding }
}

/** Default "colour by": the free gene that varies most along the front (a constant gene gives a useless colour bar). */
export function defaultColorGene(front: MOCandidate[], freeGenes: string[]): string | null {
  let best: string | null = null
  let bestSd = 0
  for (const g of freeGenes) {
    const xs = front.map((c) => c.genome[g]).filter((v) => v !== undefined)
    if (xs.length < 2) continue
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
    if (sd > bestSd) {
      bestSd = sd
      best = g
    }
  }
  return bestSd > 0 ? best : null
}
