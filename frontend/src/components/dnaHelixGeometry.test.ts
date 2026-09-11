import { describe, expect, it } from 'vitest'

import { buildBokehField, buildHelixFrame, depthToLitFactor, lerpHexColor } from './dnaHelixGeometry'

describe('buildHelixFrame', () => {
  it('produces two phase-shifted strands and the requested rung count', () => {
    const { strandA, strandB, rungs } = buildHelixFrame({ rows: 10, rungCount: 4, turns: 1, phase: 0 })
    expect(strandA).toHaveLength(10)
    expect(strandB).toHaveLength(10)
    expect(rungs).toHaveLength(4)
    // At row 0, phase 0: strandA.x = 0.5 + 0.5*sin(0) = 0.5, strandB is
    // phase-shifted by PI so it mirrors around the centre line.
    expect(strandA[0].x).toBeCloseTo(0.5, 5)
    expect(strandB[0].x).toBeCloseTo(0.5, 5)
    expect(strandA[0].depth).toBeCloseTo(1, 5)
    expect(strandB[0].depth).toBeCloseTo(-1, 5)
  })
})

describe('lerpHexColor', () => {
  it('returns the start color at t=0 and end color at t=1', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('interpolates the midpoint', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('clamps t outside [0, 1]', () => {
    expect(lerpHexColor('#000000', '#ffffff', -1)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 2)).toBe('#ffffff')
  })
})

describe('depthToLitFactor', () => {
  it('is highest at depth=1 (nearest) and lowest at depth=-1 (farthest)', () => {
    const near = depthToLitFactor(1)
    const far = depthToLitFactor(-1)
    expect(near).toBeGreaterThan(far)
    expect(near).toBeLessThanOrEqual(1)
    expect(far).toBeGreaterThanOrEqual(0)
  })

  it('is monotonic in depth', () => {
    expect(depthToLitFactor(0.5)).toBeGreaterThan(depthToLitFactor(-0.5))
  })
})

describe('buildBokehField', () => {
  it('returns the requested count of dots with values in range', () => {
    const dots = buildBokehField(20, 7)
    expect(dots).toHaveLength(20)
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(1)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeLessThanOrEqual(1)
      expect(d.r).toBeGreaterThan(0)
      expect(d.phase).toBeGreaterThanOrEqual(0)
      expect(d.phase).toBeLessThanOrEqual(Math.PI * 2)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = buildBokehField(10, 42)
    const b = buildBokehField(10, 42)
    expect(a).toEqual(b)
  })

  it('produces a different layout for a different seed', () => {
    const a = buildBokehField(10, 1)
    const b = buildBokehField(10, 2)
    expect(a).not.toEqual(b)
  })
})
