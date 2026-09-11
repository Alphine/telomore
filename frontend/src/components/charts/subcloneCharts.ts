// Stacked-area chart of clone_fraction over cycles (docs/MODEL.md §2.2,
// sub-clone competition). One trace per clone, stacked to 1.0 so the chart
// reads as "share of the living population", matching the composition
// readout under it.
import type { Data } from 'plotly.js-dist-min'

import type { Figure } from './Plot'
import { CURSOR_COLOR, PALETTE, baseLayout, vline } from './theme'

/** One filled, stacked area trace per clone from a `clone_fraction`-shaped record (arrays cycles + 1 long). */
export function cloneFractionTraces(cloneFraction: Record<string, number[]>): Data[] {
  return Object.entries(cloneFraction).map(([name, ys], i) => ({
    type: 'scatter' as const,
    mode: 'lines' as const,
    x: ys.map((_, t) => t),
    y: ys,
    name,
    stackgroup: 'clones',
    line: { width: 1, color: PALETTE[i % PALETTE.length] },
  }))
}

export function cloneFractionChart(cloneFraction: Record<string, number[]>, dark: boolean, cursor?: number | null): Figure {
  const data = cloneFractionTraces(cloneFraction)
  const base = baseLayout({ dark, title: 'Sub-clone composition', xTitle: 'cell cycle', yTitle: 'fraction of population', height: 300 })
  return {
    data,
    layout: {
      ...base,
      yaxis: { ...base.yaxis, range: [0, 1] },
      shapes: cursor === null || cursor === undefined ? [] : [vline(cursor, CURSOR_COLOR, 'solid', 1.5)],
    },
  }
}
