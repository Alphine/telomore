// Port of app/ui/charts.py::overlay (and comparison_grid, rendered here as
// three separate overlays instead of a subplot row) for the Compare page.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { ScenarioRun, SimulationTimeseries } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout, hline } from './theme'

export type OverlayMetric = keyof Omit<SimulationTimeseries, 'cycle'>

export function overlayChart(
  runs: Array<{ name: string; run: ScenarioRun }>,
  metric: OverlayMetric,
  title: string,
  yTitle: string,
  dark: boolean,
  opts: { kb?: boolean; hline?: number; hlineLabel?: string; height?: number } = {},
): Figure {
  const data: Data[] = runs.map(({ name, run }, i) => {
    const y = run.timeseries[metric] as Array<number | null>
    return {
      type: 'scatter',
      mode: 'lines',
      x: run.timeseries.cycle,
      y: opts.kb ? y.map((v) => (v === null ? null : v / 1000)) : y,
      name,
      line: { color: PALETTE[i % PALETTE.length], width: 2 },
    }
  })
  const layout: Partial<Layout> = baseLayout({ dark, title, xTitle: 'cell cycle', yTitle, height: opts.height })
  if (opts.hline !== undefined) {
    const h = hline(opts.hline, opts.hlineLabel)
    layout.shapes = [h.shape]
    layout.annotations = h.annotation ? [h.annotation] : []
  }
  return { data, layout }
}
