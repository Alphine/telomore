// Port of app/ui/charts.py::tornado_chart. `items` are ParameterSensitivity
// dicts (job progress payloads / result.items); sorting by |swing| happens
// here so the live table and the chart agree.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { ParameterSensitivity } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout, vline } from './theme'

const abs = (v: number | null) => (v === null ? -1 : Math.abs(v))

/** SensitivityResult.to_frame(): sorted by |swing| descending (null swings last). */
export function sortBySwing(items: ParameterSensitivity[]): ParameterSensitivity[] {
  return [...items].sort((a, b) => abs(b.swing) - abs(a.swing))
}

/** Horizontal diverging bars from the baseline fitness, largest |swing| at the top. */
export function tornadoChart(items: ParameterSensitivity[], perturbationFraction: number, dark: boolean): Figure {
  const sorted = sortBySwing(items).reverse() // plotly draws the first row at the bottom
  const baseline = sorted.find((it) => it.fitness_baseline !== null)?.fitness_baseline ?? 0
  const pct = Math.round(perturbationFraction * 100)
  const data: Data[] = [
    {
      type: 'bar',
      orientation: 'h',
      y: sorted.map((it) => it.parameter),
      x: sorted.map((it) => (it.fitness_low === null ? null : it.fitness_low - baseline)),
      base: baseline,
      name: `-${pct}%`,
      marker: { color: PALETTE[1] },
      hovertemplate: '%{y}: low %{x:+.4f}<extra></extra>',
    },
    {
      type: 'bar',
      orientation: 'h',
      y: sorted.map((it) => it.parameter),
      x: sorted.map((it) => (it.fitness_high === null ? null : it.fitness_high - baseline)),
      base: baseline,
      name: `+${pct}%`,
      marker: { color: PALETTE[2] },
      hovertemplate: '%{y}: high %{x:+.4f}<extra></extra>',
    },
  ]
  const layout: Partial<Layout> = {
    ...baseLayout({
      dark,
      title: 'Fitness sensitivity (one-at-a-time perturbation)',
      xTitle: 'fitness',
      yTitle: 'parameter',
      height: Math.max(280, 60 + 40 * sorted.length),
    }),
    barmode: 'overlay',
    hovermode: 'closest',
    margin: { l: 150, r: 20, t: 50, b: 40 },
    shapes: [vline(baseline)],
  }
  return { data, layout }
}
