import { describe, expect, it } from 'vitest'

import {
  PARTICLE_STRIDE,
  frameAt,
  frameCount,
  makeParticles,
  mulberry32,
  stepParticles,
} from './populationFrames'
import type { FrameSource } from './populationFrames'

const run: FrameSource = {
  config: { initial_length: 8000 } as FrameSource['config'],
  timeseries: {
    cycle: [0, 1, 2, 3],
    mean_length_bp: [8000, 6000, 4000, null],
    median_length_bp: [8000, 6000, 4000, null],
    shortest_length_bp: [7000, 4000, 2000, null],
    p10_length_bp: [7500, 5000, 3000, null],
    mean_shortest_per_cell_bp: [7500, 5000, 3000, null],
    senescent_fraction: [0, 0.25, 0.5, null],
    population_size: [100, 2000, 40, 0],
    proliferative_count: [100, 1500, 20, 0],
    fraction_below_threshold: [0, 0.1, 0.5, null],
    length_cv: [0.1, 0.1, 0.2, null],
  },
}

describe('frameAt', () => {
  it('maps population, senescence and length ratios from the timeseries', () => {
    const f = frameAt(run, 1, 1500)
    expect(f.cycle).toBe(1)
    expect(f.living).toBe(2000)
    expect(f.proliferative).toBe(1500)
    expect(f.senescentFraction).toBe(0.25)
    expect(f.drawn).toBe(1500) // capped for performance
    expect(f.drawnSenescent).toBe(375)
    expect(f.lengthRatio).toBeCloseTo(0.75)
    expect(f.shortestRatio).toBeCloseTo(0.5)
    expect(f.extinct).toBe(false)
  })

  it('draws every cell when below the cap', () => {
    const f = frameAt(run, 2)
    expect(f.drawn).toBe(40)
    expect(f.drawnSenescent).toBe(20)
    expect(f.lengthRatio).toBeCloseTo(0.5)
  })

  it('treats an extinct population (null length stats) as fully lost', () => {
    const f = frameAt(run, 3)
    expect(f.living).toBe(0)
    expect(f.drawn).toBe(0)
    expect(f.extinct).toBe(true)
    expect(f.senescentFraction).toBe(1)
    expect(f.lengthRatio).toBe(0)
  })

  it('clamps the index into range and counts frames', () => {
    expect(frameCount(run)).toBe(4)
    expect(frameAt(run, -5).cycle).toBe(0)
    expect(frameAt(run, 99).cycle).toBe(3)
    expect(frameAt(run, 1.9).cycle).toBe(1)
  })

  it('handles an empty timeseries', () => {
    const empty: FrameSource = { config: run.config, timeseries: { ...run.timeseries, cycle: [] } }
    expect(frameCount(empty)).toBe(0)
    expect(frameAt(empty, 0).drawn).toBe(0)
  })
})

describe('particles', () => {
  it('are deterministic for a seed and start inside the unit disk', () => {
    const a = makeParticles(50, 7)
    const b = makeParticles(50, 7)
    expect(a).toEqual(b)
    expect(a.length).toBe(50 * PARTICLE_STRIDE)
    for (let i = 0; i < 50; i++) {
      const x = a[i * PARTICLE_STRIDE]
      const y = a[i * PARTICLE_STRIDE + 1]
      expect(x * x + y * y).toBeLessThanOrEqual(1)
    }
    expect(makeParticles(50, 8)).not.toEqual(a)
  })

  it('stay inside the dish after many steps', () => {
    const p = makeParticles(200, 3)
    for (let k = 0; k < 2000; k++) stepParticles(p, 0.1)
    for (let i = 0; i < 200; i++) {
      const x = p[i * PARTICLE_STRIDE]
      const y = p[i * PARTICLE_STRIDE + 1]
      expect(x * x + y * y).toBeLessThanOrEqual(1 + 1e-6)
    }
  })

  it('mulberry32 yields values in [0, 1)', () => {
    const rnd = mulberry32(1)
    for (let i = 0; i < 100; i++) {
      const v = rnd()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
