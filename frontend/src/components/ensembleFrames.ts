// Pure per-seed data -> frame mapping for <EnsemblePopulationCanvas />, the
// scope-reduced multi-stream sibling of <PopulationCanvas /> (see that
// component's docstring for why: rendering only, every number comes from the
// server-side ensemble run). Mirrors populationFrames.ts::frameAt's math but
// reads the light-weight per-seed arrays POST /api/simulate/ensemble returns
// (EnsembleSeedResult) instead of a full SimulationRun's timeseries.
import type { EnsembleSeedResult } from '../api/types'
import type { PopulationFrame } from './populationFrames'

function ratio(value: number | null | undefined, initial: number): number {
  if (value === null || value === undefined || !Number.isFinite(value) || initial <= 0) return 0
  return Math.min(1.5, Math.max(0, value / initial))
}

export function ensembleSeedFrameCount(seed: EnsembleSeedResult): number {
  return seed.mean_length.length
}

/** Same shape/semantics as populationFrames.ts::frameAt, for one ensemble seed. */
export function ensembleSeedFrameAt(
  seed: EnsembleSeedResult,
  cycle: number[],
  initialLength: number,
  index: number,
  cap: number,
): PopulationFrame {
  const n = seed.population_size.length
  if (n === 0 || !seed.valid) {
    return {
      cycle: cycle[Math.min(index, cycle.length - 1)] ?? 0,
      living: 0,
      proliferative: 0,
      senescentFraction: 1,
      drawn: 0,
      drawnSenescent: 0,
      lengthRatio: 0,
      shortestRatio: 0,
      extinct: true,
    }
  }
  const i = Math.min(n - 1, Math.max(0, Math.floor(index)))
  const living = Math.max(0, Math.round(seed.population_size[i] ?? 0))
  const proliferative = Math.max(0, Math.round(seed.proliferative_count[i] ?? 0))
  const extinct = living === 0
  const rawSen = seed.senescent_fraction[i]
  const senescentFraction = extinct
    ? 1
    : rawSen === null || rawSen === undefined || !Number.isFinite(rawSen)
      ? 0
      : Math.min(1, Math.max(0, rawSen))
  const drawn = Math.min(living, Math.max(0, Math.floor(cap)))
  const drawnSenescent = Math.round(drawn * senescentFraction)
  return {
    cycle: cycle[i] ?? i,
    living,
    proliferative,
    senescentFraction,
    drawn,
    drawnSenescent,
    lengthRatio: ratio(seed.mean_length[i], initialLength),
    shortestRatio: ratio(seed.shortest_length[i], initialLength),
    extinct,
  }
}
