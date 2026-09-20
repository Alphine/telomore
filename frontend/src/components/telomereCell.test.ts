import { describe, expect, it } from 'vitest'

import { fakeRun } from '../test/fixtures'
import { cellFrameAt, chromosomeCount, classify, firstFrameAtStage, telomereColor } from './telomereCell'

describe('classify', () => {
  it('walks normal -> eroding -> critical -> senescent as the shortest end approaches the limit', () => {
    expect(classify(6000, 3000, 0, false)).toBe('normal')
    expect(classify(4000, 3000, 0, false)).toBe('eroding')
    expect(classify(3300, 3000, 0, false)).toBe('critical')
    expect(classify(2900, 3000, 0, false)).toBe('senescent')
    expect(classify(6000, 3000, 0.6, false)).toBe('senescent')
    expect(classify(6000, 3000, 0, true)).toBe('extinct')
  })
})

describe('cellFrameAt', () => {
  const run = fakeRun(10)

  it('draws telomeres_per_cell / 2 chromosomes, capped at 16', () => {
    expect(chromosomeCount(run)).toBe(16)
    expect(chromosomeCount({ config: { ...run.config, telomeres_per_cell: 6 } })).toBe(3)
  })

  it('reconstructs lengths that match the reported mean and shortest end', () => {
    const f = cellFrameAt(run, 3)
    expect(f.lengths).toHaveLength(32)
    expect(Math.min(...f.lengths)).toBeCloseTo(f.shortest, 6)
    expect(f.lengths.reduce((a, b) => a + b, 0) / f.lengths.length).toBeCloseTo(f.mean, 6)
  })

  it('is deterministic for a given run', () => {
    expect(cellFrameAt(run, 4).lengths).toEqual(cellFrameAt(run, 4).lengths)
  })

  it('erodes over the run and finds the stage transitions', () => {
    const first = cellFrameAt(run, 0)
    const last = cellFrameAt(run, run.timeseries.cycle.length - 1)
    expect(last.shortest).toBeLessThan(first.shortest)
    expect(first.stage).toBe('normal')
    expect(firstFrameAtStage(run, 'senescent')).toBeGreaterThan(0)
  })

  it('survives an extinct tail of null statistics', () => {
    const n = run.timeseries.cycle.length
    const extinct = {
      ...run,
      timeseries: {
        ...run.timeseries,
        population_size: run.timeseries.population_size.map((v, i) => (i === n - 1 ? 0 : v)),
        mean_length_bp: run.timeseries.mean_length_bp.map((v, i) => (i === n - 1 ? null : v)),
        mean_shortest_per_cell_bp: run.timeseries.mean_shortest_per_cell_bp.map((v, i) => (i === n - 1 ? null : v)),
      },
    }
    const f = cellFrameAt(extinct, n - 1)
    expect(f.stage).toBe('extinct')
    expect(f.lengths.every(Number.isFinite)).toBe(true)
  })
})

describe('telomereColor', () => {
  it('goes teal -> amber -> red as length falls to the limit', () => {
    const [, gLong] = telomereColor(9000, 3000)
    const [rMid] = telomereColor(4500, 3000)
    const [rShort, gShort] = telomereColor(500, 3000)
    expect(gLong).toBeGreaterThan(0.5)
    expect(rMid).toBeGreaterThan(0.4)
    expect(rShort).toBeGreaterThan(0.8)
    expect(gShort).toBeLessThan(0.3)
  })
})
