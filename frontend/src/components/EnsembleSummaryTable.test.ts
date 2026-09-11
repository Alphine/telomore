import { describe, expect, it } from 'vitest'

import type { EnsembleSeedResult } from '../api/types'
import { summaryRows } from './EnsembleSummaryTable'

function seed(n: number, terminal: Partial<EnsembleSeedResult['terminal_metrics']>, valid = true): EnsembleSeedResult {
  return {
    seed: n,
    valid,
    failure_reason: null,
    mean_length: [],
    shortest_length: [],
    population_size: [],
    proliferative_count: [],
    senescent_fraction: [],
    terminal_metrics: terminal,
  }
}

describe('summaryRows', () => {
  it('computes min/mean/max/std across seeds for each key terminal metric, in kb/percent as applicable', () => {
    const series = [
      seed(1, { final_mean_length_bp: 6000, final_senescent_fraction: 0.1, normalized_survival: 0.9, final_population_size: 100 }),
      seed(2, { final_mean_length_bp: 8000, final_senescent_fraction: 0.3, normalized_survival: 0.7, final_population_size: 120 }),
    ]
    const rows = summaryRows(series)
    const length = rows.find((r) => r.label === 'Final mean length')!
    expect(length.unit).toBe('kb')
    expect(length.min).toBeCloseTo(6)
    expect(length.max).toBeCloseTo(8)
    expect(length.mean).toBeCloseTo(7)
    expect(length.std).toBeCloseTo(1)

    const sen = rows.find((r) => r.label === 'Senescent fraction')!
    expect(sen.unit).toBe('%')
    expect(sen.min).toBeCloseTo(10)
    expect(sen.max).toBeCloseTo(30)
  })

  it('excludes invalid seeds from the statistics', () => {
    const series = [
      seed(1, { final_mean_length_bp: 6000 }),
      seed(2, { final_mean_length_bp: 999999 }, false),
    ]
    const rows = summaryRows(series)
    const length = rows.find((r) => r.label === 'Final mean length')!
    expect(length.min).toBeCloseTo(6)
    expect(length.max).toBeCloseTo(6)
  })

  it('returns nulls for a metric with no finite values across any valid seed', () => {
    const rows = summaryRows([seed(1, {})])
    expect(rows.every((r) => r.min === null && r.mean === null)).toBe(true)
  })
})
