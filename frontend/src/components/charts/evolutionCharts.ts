// 1:1 ports of the Evolve-page figures in app/ui/charts.py
// (evolution_fitness_chart, diversity_chart, parameter_trajectory_chart).
// `history` is the list of GenerationRecord dicts (the API's per-generation
// progress payload / the completed job's result.history).
import type { Data, Layout } from 'plotly.js-dist-min'

import type { GenerationRecord, ParameterBound } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout } from './theme'

export function evolutionFitnessChart(history: GenerationRecord[], dark: boolean): Figure {
  const gen = history.map((h) => h.generation)
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: gen,
      y: history.map((h) => h.best_fitness),
      name: 'best',
      line: { color: PALETTE[0], width: 2 },
    },
    { type: 'scatter', mode: 'lines', x: gen, y: history.map((h) => h.mean_fitness), name: 'mean', line: { color: PALETTE[3], dash: 'dot' } },
    {
      type: 'scatter',
      mode: 'lines',
      x: gen,
      y: history.map((h) => h.median_fitness),
      name: 'median',
      line: { color: PALETTE[2], dash: 'dash' },
    },
  ]
  return { data, layout: baseLayout({ dark, title: 'Fitness by generation', xTitle: 'generation', yTitle: 'fitness' }) }
}

export function diversityChart(history: GenerationRecord[], dark: boolean): Figure {
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: history.map((h) => h.generation),
      y: history.map((h) => h.diversity),
      name: 'diversity',
      line: { color: PALETTE[4] },
      fill: 'tozeroy',
    },
  ]
  return {
    data,
    layout: baseLayout({
      dark,
      title: 'Population diversity (mean gene SD, normalised)',
      xTitle: 'generation',
      yTitle: 'diversity',
      showLegend: false,
    }),
  }
}

export function parameterTrajectoryChart(
  history: GenerationRecord[],
  genes: string[],
  bounds: Record<string, ParameterBound>,
  dark: boolean,
): Figure {
  const gen = history.map((h) => h.generation)
  const data: Data[] = genes
    .filter((g) => g in bounds)
    .map((g, i) => {
      const { min: lo, max: hi } = bounds[g]
      const raw = history.map((h) => h.best_genome[g])
      return {
        type: 'scatter' as const,
        mode: 'lines+markers' as const,
        x: gen,
        y: raw.map((v) => (v === undefined ? null : (v - lo) / (hi - lo))),
        name: g,
        line: { color: PALETTE[i % PALETTE.length] },
        customdata: raw,
        hovertemplate: `${g}: %{customdata:.3f}<extra></extra>`,
      }
    })
  const base = baseLayout({
    dark,
    title: "Best candidate's parameters (normalised to gene bounds)",
    xTitle: 'generation',
    yTitle: 'position in [min, max]',
  })
  const layout: Partial<Layout> = { ...base, yaxis: { ...base.yaxis, range: [-0.02, 1.02] } }
  return { data, layout }
}
