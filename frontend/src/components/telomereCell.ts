// Data -> geometry mapping for the 3D "representative cell" view
// (TelomereCell3D.tsx). Pure, no DOM/WebGL, so it can be unit-tested.
//
// Nothing is simulated here. The server returns per-cycle *summary* statistics
// (mean length, mean of each cell's shortest telomere, senescent fraction).
// A representative cell is reconstructed from them: its telomere lengths are
// spread evenly and symmetrically around the mean, with the shortest one
// pinned to the reported mean-shortest-per-cell. The view is therefore an
// illustration of the population's typical cell, not a measured single cell.
import type { SimulationRun } from '../api/types'
import { mulberry32 } from './populationFrames'

export type CellStage = 'normal' | 'eroding' | 'critical' | 'senescent' | 'extinct'

export const STAGE_LABEL: Record<CellStage, string> = {
  normal: 'Normal — telomeres long',
  eroding: 'Partially eroded',
  critical: 'Critically short',
  senescent: 'Depleted — senescent',
  extinct: 'Culture extinct',
}

export interface CellFrame {
  cycle: number
  stage: CellStage
  /** Telomere lengths (bp), one per chromosome end, in display order. */
  lengths: number[]
  threshold: number
  initialLength: number
  shortest: number
  mean: number
  /** True per telomere when it is below the senescence threshold. */
  critical: boolean[]
}

export const MAX_CHROMOSOMES = 16

/** Number of chromosomes drawn (two telomeres each), from the model's telomeres_per_cell. */
export function chromosomeCount(run: Pick<SimulationRun, 'config'>): number {
  const ends = Math.max(2, Math.round(run.config.telomeres_per_cell ?? 32))
  return Math.min(MAX_CHROMOSOMES, Math.max(1, Math.floor(ends / 2)))
}

function finite(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v)
}

/** Stage from the typical cell's shortest telomere relative to the senescence threshold. */
export function classify(shortest: number, threshold: number, senescentFraction: number, extinct: boolean): CellStage {
  if (extinct) return 'extinct'
  if (threshold <= 0) return 'normal'
  if (shortest < threshold || senescentFraction >= 0.5) return 'senescent'
  const r = shortest / threshold
  if (r < 1.15) return 'critical'
  if (r < 1.6) return 'eroding'
  return 'normal'
}

export function cellFrameAt(run: SimulationRun, index: number): CellFrame {
  const ts = run.timeseries
  const n = ts.cycle.length
  const threshold = run.config.senescence_threshold
  const initialLength = run.config.initial_length
  const i = Math.min(Math.max(0, n - 1), Math.max(0, Math.floor(index)))
  const extinct = n === 0 || (ts.population_size[i] ?? 0) <= 0

  // Extinct cultures report null stats: fall back to the last frame with a value.
  let j = i
  while (j > 0 && !finite(ts.mean_length_bp[j])) j--
  const mean = finite(ts.mean_length_bp[j]) ? ts.mean_length_bp[j]! : initialLength
  const shortestRaw = ts.mean_shortest_per_cell_bp[j]
  const shortest = Math.min(mean, finite(shortestRaw) ? shortestRaw : mean)
  const senFrac = finite(ts.senescent_fraction[i]) ? ts.senescent_fraction[i]! : extinct ? 1 : 0

  const total = chromosomeCount(run) * 2
  // Even spread s .. 2m - s (mean m, shortest s); fixed shuffle so the layout is stable across frames.
  const rng = mulberry32(run.seed || 1)
  const order = Array.from({ length: total }, (_, k) => k)
  for (let k = total - 1; k > 0; k--) {
    const r = Math.floor(rng() * (k + 1))
    ;[order[k], order[r]] = [order[r], order[k]]
  }
  const lengths = new Array<number>(total)
  for (let rank = 0; rank < total; rank++) {
    const q = total === 1 ? 0.5 : rank / (total - 1)
    lengths[order[rank]] = Math.max(0, shortest + q * 2 * (mean - shortest))
  }
  return {
    cycle: n === 0 ? 0 : ts.cycle[i],
    stage: classify(shortest, threshold, senFrac, extinct),
    lengths,
    threshold,
    initialLength,
    shortest,
    mean,
    critical: lengths.map((l) => l < threshold),
  }
}

/** First frame index at which the typical cell reaches `stage` (or the last frame if it never does). */
export function firstFrameAtStage(run: SimulationRun, stage: CellStage): number {
  const n = run.timeseries.cycle.length
  for (let i = 0; i < n; i++) if (cellFrameAt(run, i).stage === stage) return i
  return Math.max(0, n - 1)
}

/** Last frame with a living culture: the most-eroded state the run reaches ("depleted"). */
export function lastLiveFrame(run: SimulationRun): number {
  const ps = run.timeseries.population_size
  for (let i = ps.length - 1; i >= 0; i--) if ((ps[i] ?? 0) > 0) return i
  return 0
}

/** Colour of a telomere cap, [r,g,b] in 0..1: teal (healthy) -> amber -> red (below threshold). */
export function telomereColor(length: number, threshold: number): [number, number, number] {
  const r = threshold > 0 ? length / threshold : 2
  const lerp = (a: number[], b: number[], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
  const TEAL = [0.05, 0.58, 0.53]
  const AMBER = [0.96, 0.62, 0.04]
  const RED = [0.86, 0.15, 0.15]
  // teal above 2x the limit, amber at 1.5x, red from 1.1x down (the limit itself is 1x).
  if (r >= 2) return [TEAL[0], TEAL[1], TEAL[2]]
  if (r >= 1.5) return lerp(AMBER, TEAL, (r - 1.5) / 0.5)
  if (r >= 1.1) return lerp(RED, AMBER, (r - 1.1) / 0.4)
  return [RED[0], RED[1], RED[2]]
}
