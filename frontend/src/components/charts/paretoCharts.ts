// Ports of the Pareto-page figures in app/ui/charts.py (pareto_scatter,
// hypervolume_chart). The API's pareto result has no final_population, so the
// "dominated candidates" cloud of the Streamlit scatter is not drawn.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { MOCandidate, MOGenerationRecord, ObjectiveInfo } from '../../api/types'
import type { Figure } from './Plot'
import { PALETTE, baseLayout } from './theme'

const HOVER_GENES = ['stress_level', 'maintenance_rate', 'repair_rate', 'shortening_rate', 'initial_length', 'senescence_threshold']

/** Front sorted by the first objective (ParetoResult.front_frame sorts by vector[0], i.e. the same order). */
export function sortedFront(front: MOCandidate[], objectives: string[], objInfo: Record<string, ObjectiveInfo>): MOCandidate[] {
  const ox = objectives[0]
  const sign = objInfo[ox]?.direction === 'max' ? -1 : 1
  return [...front].sort((a, b) => sign * (a.objectives[ox] - b.objectives[ox]))
}

/**
 * 2-D Pareto front over the first two objectives; `colorBy` (a gene or a third
 * objective) colours the markers with a Viridis colour bar, hover lists the
 * genes. The baseline candidate is the red X.
 */
export function paretoScatter(
  front: MOCandidate[],
  objectives: string[],
  objInfo: Record<string, ObjectiveInfo>,
  baseline: MOCandidate | null,
  colorBy: string | null,
  dark: boolean,
): Figure {
  const [ox, oy] = objectives
  const f = sortedFront(front, objectives, objInfo)
  const data: Data[] = []
  if (f.length) {
    const hover = f.map((c) => {
      const genes = HOVER_GENES.filter((g) => g in c.genome)
        .map((g) => `<br>${g}: ${c.genome[g].toFixed(3)}`)
        .join('')
      return `<b>${ox}</b> ${c.objectives[ox].toFixed(3)}<br><b>${oy}</b> ${c.objectives[oy].toFixed(3)}${genes}`
    })
    const colorValues = colorBy ? f.map((c) => c.genome[colorBy] ?? c.objectives[colorBy]) : null
    const marker =
      colorValues && colorValues.every((v) => v !== undefined)
        ? {
            size: 11,
            line: { width: 1, color: 'white' },
            color: colorValues,
            colorscale: 'Viridis' as const,
            showscale: true,
            colorbar: { title: { text: colorBy ?? '' }, thickness: 12 },
          }
        : { size: 11, line: { width: 1, color: 'white' }, color: PALETTE[0] }
    data.push({
      type: 'scatter',
      mode: 'lines+markers',
      x: f.map((c) => c.objectives[ox]),
      y: f.map((c) => c.objectives[oy]),
      name: 'Pareto front',
      line: { color: PALETTE[0], width: 1.5, dash: 'dot' },
      marker,
      text: hover,
      hovertemplate: '%{text}<extra>Pareto</extra>',
    })
  }
  if (baseline) {
    data.push({
      type: 'scatter',
      mode: 'markers',
      x: [baseline.objectives[ox]],
      y: [baseline.objectives[oy]],
      name: 'baseline',
      marker: { symbol: 'x', size: 14, color: PALETTE[1], line: { width: 2 } },
    })
  }
  const layout: Partial<Layout> = {
    ...baseLayout({
      dark,
      title: 'Pareto front (model outputs)',
      xTitle: `${ox} (${objInfo[ox]?.direction ?? ''}imise)`,
      yTitle: `${oy} (${objInfo[oy]?.direction ?? ''}imise)`,
      height: 460,
    }),
    hovermode: 'closest',
  }
  return { data, layout }
}

/** Hypervolume (left axis) and front size (right axis) by generation; live while the job runs. */
export function hypervolumeChart(history: MOGenerationRecord[], dark: boolean): Figure {
  const gen = history.map((h) => h.generation)
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines+markers',
      x: gen,
      y: history.map((h) => h.hypervolume),
      name: 'hypervolume',
      line: { color: PALETTE[0], width: 2 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: gen,
      y: history.map((h) => h.front_size),
      name: 'front size',
      line: { color: PALETTE[3], dash: 'dot' },
      yaxis: 'y2',
    },
  ]
  const base = baseLayout({ dark, title: 'Front quality by generation', xTitle: 'generation', yTitle: '2-D hypervolume' })
  const layout: Partial<Layout> = {
    ...base,
    margin: { ...base.margin, r: 50 },
    yaxis2: {
      ...(base.yaxis ?? {}),
      title: { text: 'non-dominated candidates' },
      overlaying: 'y',
      side: 'right',
      showgrid: false,
    },
  }
  return { data, layout }
}
