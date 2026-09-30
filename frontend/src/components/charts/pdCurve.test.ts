import { describe, expect, it } from 'vitest'

import { fakeRun } from '../../test/fixtures'
import { pdCurve } from './simulationCharts'

describe('pdCurve', () => {
  it('plots doublings against the model cycle when no time axis is set', () => {
    const run = fakeRun(4)
    const fig = pdCurve(run, false)!
    expect(fig.data[0]).toMatchObject({ x: run.timeseries.cycle, y: run.timeseries.population_doublings })
    expect(String((fig.layout.xaxis?.title as { text?: string })?.text)).toBe('cell cycle')
  })

  it('uses days when hours_per_cycle produced a time axis', () => {
    const run = fakeRun(4)
    run.timeseries.time_hours = run.timeseries.cycle.map((c) => c * 24)
    const fig = pdCurve(run, false)!
    expect((fig.data[0] as { x: number[] }).x).toEqual([0, 1, 2, 3, 4])
    expect(String((fig.layout.xaxis?.title as { text?: string })?.text)).toMatch(/days/)
  })

  it('returns null for runs recorded before doublings existed', () => {
    const run = fakeRun(4)
    delete run.timeseries.population_doublings
    expect(pdCurve(run, false)).toBeNull()
  })
})
