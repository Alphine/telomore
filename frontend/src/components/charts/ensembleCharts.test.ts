import { describe, expect, it } from 'vitest'

import type { EnsembleBands } from '../../api/types'
import { ensembleFanChart } from './ensembleCharts'

describe('ensembleFanChart', () => {
  const bands: EnsembleBands = {
    cycle: [0, 1, 2],
    p10: [7000, 6000, 5000],
    p50: [7500, 6600, 5800],
    p90: [8000, 7200, 6600],
    mean: [7500, 6600, 5800],
  }

  it('converts bp to kb for every band and keeps percentile ordering p10 <= p50 <= p90', () => {
    const fig = ensembleFanChart(bands, false)
    expect(fig.data).toHaveLength(4)
    const [p90Trace, p10Trace, p50Trace, meanTrace] = fig.data as Array<{ x: number[]; y: Array<number | null>; name: string }>
    expect(p90Trace.name).toBe('p90')
    expect(p90Trace.y).toEqual([8, 7.2, 6.6])
    expect(p10Trace.name).toBe('p10-p90 spread')
    expect(p10Trace.y).toEqual([7, 6, 5])
    expect(p50Trace.name).toBe('median (p50)')
    expect(p50Trace.y).toEqual([7.5, 6.6, 5.8])
    expect(meanTrace.name).toBe('mean')
    expect(meanTrace.y).toEqual([7.5, 6.6, 5.8])
    for (let i = 0; i < bands.cycle.length; i++) {
      expect((p10Trace.y[i] as number) <= (p50Trace.y[i] as number)).toBe(true)
      expect((p50Trace.y[i] as number) <= (p90Trace.y[i] as number)).toBe(true)
    }
  })

  it('fills the band between the p90 and p10 traces (tonexty) and draws a senescence threshold line when given', () => {
    const fig = ensembleFanChart(bands, false)
    const p10Trace = fig.data[1] as { fill?: string }
    expect(p10Trace.fill).toBe('tonexty')
    expect(fig.layout.shapes).toEqual([])

    const withThreshold = ensembleFanChart(bands, false, 3000)
    expect(withThreshold.layout.shapes).toHaveLength(1)
  })

  it('maps null entries (extinct / invalid seeds excluded from a percentile) through to null kb values', () => {
    const withNulls: EnsembleBands = { cycle: [0, 1], p10: [7000, null], p50: [7500, null], p90: [8000, null], mean: [7500, null] }
    const fig = ensembleFanChart(withNulls, true)
    const p10Trace = fig.data[1] as { y: Array<number | null> }
    expect(p10Trace.y).toEqual([7, null])
  })
})
