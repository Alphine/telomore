// Synthetic "biological age" score over time (ROADMAP.md candidate feature
// #5) -- a simple line trace alongside the other Simulate-page trajectories,
// same theme/cursor conventions as simulationCharts.ts.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { SimulationRun } from '../../api/types'
import type { Figure } from './Plot'
import { CURSOR_COLOR, PALETTE, baseLayout, vline } from './theme'

export function biologicalAgeChart(run: SimulationRun, dark: boolean, cursor?: number | null): Figure | null {
  const ba = run.biological_age
  if (!ba || !ba.valid) return null
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: run.timeseries.cycle,
      y: ba.score_over_time,
      name: 'synthetic age index',
      line: { color: PALETTE[4], width: 2 },
    },
  ]
  const base = baseLayout({
    dark,
    title: 'Synthetic age index over time',
    xTitle: 'cell cycle',
    yTitle: 'age index (0-100)',
    showLegend: false,
  })
  const layout: Partial<Layout> = { ...base, yaxis: { ...base.yaxis, range: [0, 100] } }
  if (cursor !== null && cursor !== undefined) layout.shapes = [vline(cursor, CURSOR_COLOR, 'solid', 1.5)]
  return { data, layout }
}
