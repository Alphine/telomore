// Step-line figures for intervention protocols (docs/MODEL.md §2.1). A
// scheduled parameter's per-cycle value is piecewise constant, so every trace
// uses Plotly's `line.shape: 'hv'` (hold the value, then step) against the
// same `cycle` axis as the trajectory charts.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { InterventionSchedule, ScenarioRun } from '../../api/types'
import type { Figure } from './Plot'
import { CURSOR_COLOR, PALETTE, baseLayout, vline } from './theme'
import { perCycleValues } from '../scheduleUtils'

/** One 'hv' step trace per parameter from an `applied_schedule`-shaped record (arrays cycles + 1 long). */
export function stepTraces(
  applied: Record<string, number[]>,
  opts: { prefix?: string; dash?: 'solid' | 'dash' | 'dot'; colorOffset?: number } = {},
): Data[] {
  return Object.entries(applied).map(([name, ys], i) => ({
    type: 'scatter' as const,
    mode: 'lines' as const,
    x: ys.map((_, t) => t),
    y: ys,
    name: opts.prefix ? `${opts.prefix} · ${name}` : name,
    line: { shape: 'hv' as const, color: PALETTE[((opts.colorOffset ?? 0) + i) % PALETTE.length], width: 2, dash: opts.dash ?? 'solid' },
  }))
}

/** Expand a config's schedule the way the simulator applies it (cycles + 1 values per parameter). */
export function scheduleToApplied(schedule: InterventionSchedule, cycles: number): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [name, vals] of Object.entries(schedule.values)) out[name] = perCycleValues(vals, Math.max(1, cycles))
  return out
}

/**
 * "Applied protocol": the value actually in force at every cycle for each
 * scheduled parameter. All schedulable parameters are a.u. in [0, 1], so one
 * shared y axis is enough. Optional playback cursor like the Simulate charts.
 */
export function appliedScheduleChart(applied: Record<string, number[]>, dark: boolean, cursor?: number | null, title = 'Applied protocol'): Figure {
  const data = stepTraces(applied)
  const base = baseLayout({ dark, title, xTitle: 'cell cycle', yTitle: 'value (a.u.)', height: 240 })
  const layout: Partial<Layout> = {
    ...base,
    yaxis: { ...base.yaxis, range: [-0.02, 1.02] },
    shapes: cursor === null || cursor === undefined ? [] : [vline(cursor, CURSOR_COLOR, 'solid', 1.5)],
  }
  return { data, layout }
}

/**
 * Compare page: every scheduled scenario's applied protocol as dashed step
 * lines on one compact panel ("<scenario> · <parameter>"). Scenarios without
 * a schedule contribute nothing; the caller only renders this when at least
 * one scenario is scheduled.
 */
export function protocolOverlayChart(runs: Array<{ name: string; run: ScenarioRun }>, dark: boolean): Figure {
  const data: Data[] = []
  runs.forEach(({ name, run }, i) => {
    const applied = run.applied_schedule ?? {}
    if (Object.keys(applied).length) data.push(...stepTraces(applied, { prefix: name, dash: 'dash', colorOffset: i }))
  })
  const base = baseLayout({ dark, title: 'Applied protocols (scheduled scenarios)', xTitle: 'cell cycle', yTitle: 'value (a.u.)', height: 260 })
  const layout: Partial<Layout> = { ...base, yaxis: { ...base.yaxis, range: [-0.02, 1.02] } }
  return { data, layout }
}
