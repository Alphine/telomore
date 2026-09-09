// Port of app/ui/charts.py::convergence_comparison_chart for the Active
// Learning page: best fitness so far vs. real simulator evaluations. The
// Streamlit page also overlaid a random-search baseline it computed itself
// (evolution/benchmark.py::run_random_search); the API's active-learning
// result does not include one, so only the active-learning line is drawn,
// with the initial random design marked.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { ActiveLearningRecord } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout, vline } from './theme'

export function convergenceChart(records: ActiveLearningRecord[], dark: boolean): Figure {
  const sorted = [...records].sort((a, b) => a.n_real_evaluations - b.n_real_evaluations)
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: sorted.map((r) => r.n_real_evaluations),
      y: sorted.map((r) => r.best_so_far),
      name: 'Active Learning (GP-EI): best so far',
      line: { color: PALETTE[0], width: 2 },
    },
    {
      type: 'scatter',
      mode: 'markers',
      x: sorted.map((r) => r.n_real_evaluations),
      y: sorted.map((r) => r.real_fitness),
      name: 'real fitness of each evaluation',
      marker: {
        color: sorted.map((r) => (r.phase === 'initial' ? PALETTE[3] : PALETTE[4])),
        size: 7,
        opacity: 0.7,
      },
      text: sorted.map((r) => r.phase),
      hovertemplate: '%{text}: %{y:+.4f}<extra></extra>',
    },
  ]
  const lastInitial = sorted.filter((r) => r.phase === 'initial').at(-1)
  const layout: Partial<Layout> = {
    ...baseLayout({
      dark,
      title: 'Optimizer convergence (real simulator evaluations)',
      xTitle: 'simulator evaluations',
      yTitle: 'best fitness so far',
    }),
    shapes: lastInitial ? [vline(lastInitial.n_real_evaluations)] : [],
    annotations: lastInitial
      ? [
          {
            x: lastInitial.n_real_evaluations,
            y: 1,
            xref: 'x',
            yref: 'paper',
            text: 'end of random initial design',
            showarrow: false,
            xanchor: 'left',
            yanchor: 'top',
            font: { size: 11, color: 'gray' },
          },
        ]
      : [],
  }
  return { data, layout }
}
