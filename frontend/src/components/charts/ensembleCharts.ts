// Fan/spread chart for the ensemble / uncertainty visualization (ROADMAP.md
// candidate feature #2, POST /api/simulate/ensemble). Shows the p10-p90 band
// (shaded, `fill: 'tonexty'`) plus the median across seeds for the mean
// telomere length trajectory -- the same primary series `lengthTrajectory`
// plots for a single run (docs/SCIENTIFIC_SCOPE.md: this is the spread across
// independent stochastic realizations of one configuration, not biological
// population variability).
import type { Data, Layout } from 'plotly.js-dist-min'

import type { EnsembleBands } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout, hline } from './theme'

function kb(xs: Array<number | null>): Array<number | null> {
  return xs.map((v) => (v === null || v === undefined ? null : v / 1000))
}

/**
 * Pure data -> Plotly-figure transform (unit-tested with known input/output).
 * `senescenceThresholdBp` draws the same reference line as the single-run
 * length trajectory when given.
 */
export function ensembleFanChart(bands: EnsembleBands, dark: boolean, senescenceThresholdBp?: number): Figure {
  const t = bands.cycle
  const p10 = kb(bands.p10)
  const p90 = kb(bands.p90)
  const p50 = kb(bands.p50)
  const mean = kb(bands.mean)
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: t,
      y: p90,
      name: 'p90',
      line: { color: PALETTE[0], width: 0 },
      showlegend: false,
      hoverinfo: 'skip',
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: t,
      y: p10,
      name: 'p10-p90 spread',
      fill: 'tonexty',
      fillcolor: dark ? 'rgba(37,99,235,0.28)' : 'rgba(37,99,235,0.18)',
      line: { color: PALETTE[0], width: 0 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: t,
      y: p50,
      name: 'median (p50)',
      line: { color: PALETTE[0], width: 2 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: t,
      y: mean,
      name: 'mean',
      line: { color: PALETTE[2], width: 1.5, dash: 'dot' },
    },
  ]
  const layout: Partial<Layout> = {
    ...baseLayout({
      dark,
      title: 'Telomere length spread across seeds (mean length, p10/median/p90)',
      xTitle: 'cell cycle',
      yTitle: 'length (kb)',
    }),
    shapes: senescenceThresholdBp !== undefined ? [hline(senescenceThresholdBp / 1000, 'senescence threshold').shape] : [],
  }
  return { data, layout }
}
