import { describe, expect, it } from 'vitest'

import { cloneFractionChart, cloneFractionTraces } from './subcloneCharts'

describe('sub-clone composition chart', () => {
  it('builds one stacked area trace per clone from clone_fraction', () => {
    const cf = { resilient: [0.5, 0.6, 0.7], fragile: [0.5, 0.4, 0.3] }
    const traces = cloneFractionTraces(cf)
    expect(traces).toHaveLength(2)
    const t = traces[0] as { x: number[]; y: number[]; name: string; stackgroup: string }
    expect(t.name).toBe('resilient')
    expect(t.x).toEqual([0, 1, 2])
    expect(t.y).toEqual(cf.resilient)
    expect(t.stackgroup).toBe('clones')
    expect(cloneFractionTraces({})).toEqual([])
  })

  it('cloneFractionChart fixes the y axis to [0, 1] and draws the playback cursor', () => {
    const cf = { a: [0.5, 0.5], b: [0.5, 0.5] }
    const fig = cloneFractionChart(cf, false, 1)
    expect(fig.layout.yaxis).toMatchObject({ range: [0, 1] })
    expect(fig.layout.shapes).toHaveLength(1)
    expect(cloneFractionChart(cf, true).layout.shapes).toHaveLength(0)
  })
})
