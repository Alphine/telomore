import { describe, expect, it } from 'vitest'

import type { ModelConfig, SubcloneSpec } from '../api/types'
import { MODEL_DEFAULTS } from '../test/fixtures'
import {
  addClone,
  defaultClones,
  finalComposition,
  fractionSum,
  fractionsAreValid,
  hasSubclones,
  removeClone,
  setOverride,
  subclonesPayload,
  updateClone,
  withSubclones,
} from './subclonesUtils'

const CLONES: SubcloneSpec[] = [
  { name: 'resilient', initial_fraction: 0.5, overrides: { maintenance_rate: 0.6 } },
  { name: 'fragile', initial_fraction: 0.5, overrides: {} },
]

describe('subclonesUtils', () => {
  it('hasSubclones is false for unset/empty and true otherwise', () => {
    expect(hasSubclones(MODEL_DEFAULTS)).toBe(false)
    expect(hasSubclones({ ...MODEL_DEFAULTS, subclones: [] })).toBe(false)
    expect(hasSubclones({ ...MODEL_DEFAULTS, subclones: CLONES })).toBe(true)
  })

  it('fractionSum / fractionsAreValid detect a bad total', () => {
    expect(fractionSum(CLONES)).toBeCloseTo(1.0)
    expect(fractionsAreValid(CLONES)).toBe(true)
    const bad = [CLONES[0], { ...CLONES[1], initial_fraction: 0.6 }]
    expect(fractionSum(bad)).toBeCloseTo(1.1)
    expect(fractionsAreValid(bad)).toBe(false)
  })

  it('defaultClones is a valid 50/50 pair with no overrides', () => {
    const d = defaultClones()
    expect(d).toHaveLength(2)
    expect(fractionsAreValid(d)).toBe(true)
    expect(d.every((c) => Object.keys(c.overrides).length === 0)).toBe(true)
  })

  it('withSubclones attaches or drops the key', () => {
    const withThem = withSubclones(MODEL_DEFAULTS, CLONES)
    expect(withThem.subclones).toEqual(CLONES)
    const without = withSubclones(withThem, null)
    expect('subclones' in without).toBe(false)
    expect(withSubclones(MODEL_DEFAULTS, [])).not.toHaveProperty('subclones')
  })

  it('subclonesPayload omits subclones when the toggle is off even if the config carries some', () => {
    const cfg: ModelConfig = { ...MODEL_DEFAULTS, subclones: CLONES }
    expect(subclonesPayload(cfg, false)).not.toHaveProperty('subclones')
    expect(subclonesPayload(cfg, true).subclones).toEqual(CLONES)
  })

  it('addClone appends a new row and rebalances all fractions evenly', () => {
    const next = addClone(CLONES)
    expect(next).toHaveLength(3)
    expect(next.every((c) => c.initial_fraction === 1 / 3)).toBe(true)
    expect(next[2].name).toBe('clone C')
  })

  it('removeClone drops one row without touching the others', () => {
    const next = removeClone(CLONES, 0)
    expect(next).toEqual([CLONES[1]])
  })

  it('updateClone patches one row by index', () => {
    const next = updateClone(CLONES, 1, { name: 'renamed' })
    expect(next[1].name).toBe('renamed')
    expect(next[0]).toBe(CLONES[0])
  })

  it('setOverride adds/removes one override key without touching others', () => {
    const withRepair = setOverride(CLONES, 0, 'repair_rate', 0.7)
    expect(withRepair[0].overrides).toEqual({ maintenance_rate: 0.6, repair_rate: 0.7 })
    const cleared = setOverride(withRepair, 0, 'maintenance_rate', null)
    expect(cleared[0].overrides).toEqual({ repair_rate: 0.7 })
  })

  it('finalComposition reads the last entry of every clone_fraction array', () => {
    const cf = { resilient: [0.5, 0.5, 0.7], fragile: [0.5, 0.5, 0.3] }
    expect(finalComposition(cf)).toEqual([
      { name: 'resilient', fraction: 0.7 },
      { name: 'fragile', fraction: 0.3 },
    ])
    expect(finalComposition({})).toEqual([])
  })
})
