import { describe, expect, it } from 'vitest'

import { BOUNDS } from '../test/fixtures'
import {
  buildSchedule,
  configPayload,
  genomeToConfig,
  groupGenes,
  meanApplied,
  perCycleValues,
  phaseBounds,
  phaseIndex,
  resizePhases,
  splitGeneName,
  withSchedule,
} from './scheduleUtils'

describe('phaseIndex (schemas.phase_index, MODEL.md §2.1)', () => {
  it('splits 120 cycles into 6 blocks of 20 and clamps t = cycles onto the last phase', () => {
    expect(phaseIndex(0, 120, 6)).toBe(0)
    expect(phaseIndex(19, 120, 6)).toBe(0)
    expect(phaseIndex(20, 120, 6)).toBe(1)
    expect(phaseIndex(100, 120, 6)).toBe(5)
    expect(phaseIndex(119, 120, 6)).toBe(5)
    expect(phaseIndex(120, 120, 6)).toBe(5) // one past the last step -> flat step-line end
    expect(phaseBounds(120, 6)).toEqual([[0, 19], [20, 39], [40, 59], [60, 79], [80, 99], [100, 119]])
  })

  it('gives the first phases one extra step when cycles is not divisible by K', () => {
    // 10 cycles, K = 3 -> blocks of 4, 3, 3 (the MODEL.md example).
    expect(Array.from({ length: 10 }, (_, t) => phaseIndex(t, 10, 3))).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2])
    expect(phaseBounds(10, 3)).toEqual([[0, 3], [4, 6], [7, 9]])
    // 20 cycles, K = 3 -> 7, 7, 6 (the API test case).
    expect(phaseBounds(20, 3)).toEqual([[0, 6], [7, 13], [14, 19]])
    // K = 1 is the constant case; more phases than cycles leaves trailing phases empty.
    expect(phaseBounds(5, 1)).toEqual([[0, 4]])
    expect(phaseBounds(2, 3)).toEqual([[0, 0], [1, 1], [-1, -1]])
    expect(() => phaseIndex(0, 0, 1)).toThrow()
  })

  it('perCycleValues is cycles + 1 long and meanApplied averages the cycles steps only', () => {
    const per = perCycleValues([0.9, 0.3, 0.9], 20)
    expect(per).toHaveLength(21)
    expect(per.slice(0, 7).every((v) => v === 0.9)).toBe(true)
    expect(per.slice(7, 14).every((v) => v === 0.3)).toBe(true)
    expect(per[20]).toBe(0.9)
    // (7 * 0.9 + 7 * 0.3 + 6 * 0.9) / 20 -- uneven phases weighted by their length, trailing entry dropped.
    expect(meanApplied(per)).toBeCloseTo((7 * 0.9 + 7 * 0.3 + 6 * 0.9) / 20, 12)
    expect(meanApplied([0.5])).toBeNull()
    expect(meanApplied([])).toBeNull()
  })
})

describe('schedule payload builders', () => {
  it('buildSchedule emits exactly the ModelConfig.to_dict() shape and null when nothing is scheduled', () => {
    expect(buildSchedule(3, { stress_level: [0.9, 0.3, 0.9] })).toEqual({ phases: 3, values: { stress_level: [0.9, 0.3, 0.9] } })
    expect(buildSchedule(3, {})).toBeNull()
  })

  it('withSchedule sets the scalar to the phase-0 value and omits the key when constant', () => {
    const cfg = withSchedule({ ...BOUNDS.demo }, { phases: 2, values: { maintenance_rate: [0.7, 0.1] } })
    expect(cfg.schedule).toEqual({ phases: 2, values: { maintenance_rate: [0.7, 0.1] } })
    expect(cfg.maintenance_rate).toBe(0.7)
    const constant = withSchedule(cfg, null)
    expect('schedule' in constant).toBe(false)
    expect(constant.maintenance_rate).toBe(0.7)
    // configPayload strips a null schedule (what to_dict() emits for unscheduled configs) from requests.
    expect('schedule' in configPayload({ ...BOUNDS.demo, schedule: null })).toBe(false)
    expect(configPayload(cfg).schedule).toEqual(cfg.schedule)
  })

  it('resizePhases truncates or pads by repeating the last value', () => {
    expect(resizePhases([0.1, 0.2, 0.3], 2, 0)).toEqual([0.1, 0.2])
    expect(resizePhases([0.1, 0.2], 4, 0)).toEqual([0.1, 0.2, 0.2, 0.2])
    expect(resizePhases([], 3, 0.6)).toEqual([0.6, 0.6, 0.6])
  })
})

describe('gene names (evolution/genome.py)', () => {
  it('splits and groups <parameter>@<phase> genes in phase order', () => {
    expect(splitGeneName('maintenance_rate@3')).toEqual({ parameter: 'maintenance_rate', phase: 3 })
    expect(splitGeneName('stress_level')).toEqual({ parameter: 'stress_level', phase: null })
    expect(groupGenes(['repair_rate@1', 'stress_level', 'repair_rate@0'])).toEqual([
      { parameter: 'repair_rate', genes: ['repair_rate@0', 'repair_rate@1'], scheduled: true },
      { parameter: 'stress_level', genes: ['stress_level'], scheduled: false },
    ])
  })

  it('genomeToConfig assembles phase genes into a schedule (GenomeSpec.to_config)', () => {
    const cfg = genomeToConfig(BOUNDS.demo, { 'maintenance_rate@0': 0.9, 'maintenance_rate@1': 0.2, repair_rate: 0.5 }, 11)
    expect(cfg.schedule).toEqual({ phases: 2, values: { maintenance_rate: [0.9, 0.2] } })
    expect(cfg.maintenance_rate).toBe(0.9) // scalar documents the phase-0 value
    expect(cfg.repair_rate).toBe(0.5)
    expect(cfg.seed).toBe(11)
    expect(cfg.stress_level).toBe(0.6) // untouched baseline gene
    expect(Object.keys(cfg).some((k) => k.includes('@'))).toBe(false)
  })

  it('genomeToConfig keeps the classic behaviour for constant genes and drops a superseded base schedule', () => {
    const plain = genomeToConfig(BOUNDS.demo, { stress_level: 0.31 })
    expect(plain.stress_level).toBe(0.31)
    expect(plain.schedule ?? null).toBeNull()
    const base = { ...BOUNDS.demo, schedule: { phases: 2, values: { stress_level: [0.9, 0.3], repair_rate: [0.1, 0.2] } } }
    const kept = genomeToConfig(base, { stress_level: 0.5 })
    expect(kept.schedule).toEqual({ phases: 2, values: { repair_rate: [0.1, 0.2] } })
    const locked = genomeToConfig(base, { 'maintenance_rate@0': 0.4, 'maintenance_rate@1': 0.6 })
    expect(locked.schedule).toEqual({ phases: 2, values: { stress_level: [0.9, 0.3], repair_rate: [0.1, 0.2], maintenance_rate: [0.4, 0.6] } })
  })
})
