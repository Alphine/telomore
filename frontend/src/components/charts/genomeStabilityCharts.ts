// Single-trace line chart of mean_mutation_burden over cycles (docs/MODEL.md
// §2.3, genome stability). Unlike clone_fraction (stacked composition), this
// is one genome-wide scalar series -- no stackgroup, no [0, 1] y-range clamp.
import type { Data } from 'plotly.js-dist-min'

import type { SimulationTimeseries } from '../../api/types'
import type { Figure } from './Plot'
import { CURSOR_COLOR, PALETTE, baseLayout, vline } from './theme'

export function mutationBurdenChart(timeseries: SimulationTimeseries, dark: boolean, cursor?: number | null): Figure {
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: timeseries.cycle,
      y: timeseries.mean_mutation_burden,
      name: 'mean mutation burden',
      line: { width: 2, color: PALETTE[0] },
    },
  ]
  const base = baseLayout({ dark, title: 'Genome stability: mean mutation burden', xTitle: 'cell cycle', yTitle: 'mutation burden (a.u.)', height: 300 })
  return {
    data,
    layout: {
      ...base,
      shapes: cursor === null || cursor === undefined ? [] : [vline(cursor, CURSOR_COLOR, 'solid', 1.5)],
    },
  }
}
