import { describe, expect, it } from 'vitest'

import { fakeRun } from '../../test/fixtures'
import { appliedScheduleChart, protocolOverlayChart, scheduleToApplied, stepTraces } from './scheduleCharts'

describe('schedule step charts', () => {
  it('builds one hv step trace per scheduled parameter from applied_schedule', () => {
    const applied = { stress_level: [0.9, 0.9, 0.3, 0.3, 0.3], maintenance_rate: [0.1, 0.1, 0.5, 0.5, 0.5] }
    const fig = appliedScheduleChart(applied, false, 2)
    expect(fig.data).toHaveLength(2)
    const t = fig.data[0] as { x: number[]; y: number[]; name: string; line: { shape: string } }
    expect(t.name).toBe('stress_level')
    expect(t.x).toEqual([0, 1, 2, 3, 4])
    expect(t.y).toEqual(applied.stress_level)
    expect(t.line.shape).toBe('hv')
    expect(fig.layout.title).toMatchObject({ text: 'Applied protocol' })
    expect(fig.layout.shapes).toHaveLength(1) // playback cursor
    expect(appliedScheduleChart(applied, true).layout.shapes).toHaveLength(0)
  })

  it('scheduleToApplied expands a schedule with the core phase arithmetic', () => {
    expect(scheduleToApplied({ phases: 3, values: { stress_level: [0.9, 0.3, 0.9] } }, 10)).toEqual({
      stress_level: [0.9, 0.9, 0.9, 0.9, 0.3, 0.3, 0.3, 0.9, 0.9, 0.9, 0.9],
    })
  })

  it('overlay draws only scheduled scenarios, dashed and prefixed by scenario name', () => {
    const { run_id: _r, fitness: _f, ...plain } = fakeRun()
    const scheduled = { ...plain, applied_schedule: { repair_rate: [0.1, 0.1, 0.8, 0.8, 0.8] } }
    const fig = protocolOverlayChart(
      [
        { name: 'Baseline', run: plain },
        { name: 'Protocol', run: scheduled },
      ],
      false,
    )
    expect(fig.data).toHaveLength(1)
    const t = fig.data[0] as { name: string; line: { dash: string; shape: string } }
    expect(t.name).toBe('Protocol · repair_rate')
    expect(t.line.dash).toBe('dash')
    expect(t.line.shape).toBe('hv')
    expect(stepTraces({})).toEqual([])
  })
})
