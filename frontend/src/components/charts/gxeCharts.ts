// Reaction-norm chart for a G×E study (docs/ROADMAP.md 2026-09-13 follow-up
// to Genome Stability): one line per genotype, x = environment (categorical),
// y = fitness. A crossing pair of lines is the G×E-interaction signature
// this feature exists to surface.
import type { Data } from 'plotly.js-dist-min'

import type { GxECell } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout } from './theme'

export function reactionNormChart(cells: GxECell[], environmentOrder: string[], dark: boolean): Figure {
  const genotypes = [...new Set(cells.map((c) => c.genotype))]
  const data: Data[] = genotypes.map((g, i) => {
    const byEnv = new Map(cells.filter((c) => c.genotype === g).map((c) => [c.environment, c.fitness]))
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: g,
      x: environmentOrder,
      y: environmentOrder.map((e) => byEnv.get(e) ?? null),
      line: { color: PALETTE[i % PALETTE.length] },
    }
  })
  const base = baseLayout({ dark, title: 'Reaction norms (genotype x environment)', yTitle: 'fitness' })
  return {
    data,
    layout: {
      ...base,
      xaxis: { ...base.xaxis, type: 'category', title: { text: 'environment' } },
    },
  }
}
