// 1:1 ports of the Simulate-page figures in app/ui/charts.py
// (length_trajectory, length_distribution, senescence_curve, population_curve,
// fitness_breakdown_bar). Lengths are shown in kb, time in cell cycles.
import type { Data, Layout } from 'plotly.js-dist-min'

import type { FitnessBreakdown, FitnessWeights, SimulationRun } from '../../api/types'
import type { Figure } from './Plot'
import { CURSOR_COLOR, PALETTE, baseLayout, hline, vline } from './theme'

function kb(xs: Array<number | null>): Array<number | null> {
  return xs.map((v) => (v === null ? null : v / 1000))
}

/** Optional playback cursor (from PopulationCanvas) drawn as a vertical line. */
function withCursor(layout: Partial<Layout>, cursor: number | null | undefined): Partial<Layout> {
  if (cursor === null || cursor === undefined) return layout
  const shapes = [...(layout.shapes ?? []), vline(cursor, CURSOR_COLOR, 'solid', 1.5)]
  return { ...layout, shapes }
}

export function lengthTrajectory(run: SimulationRun, dark: boolean, cursor?: number | null): Figure {
  const t = run.timeseries.cycle
  const ts = run.timeseries
  const threshold = hline(run.config.senescence_threshold / 1000, 'senescence threshold')
  const data: Data[] = [
    { type: 'scatter', mode: 'lines', x: t, y: kb(ts.mean_length_bp), name: 'mean', line: { color: PALETTE[0], width: 2 } },
    { type: 'scatter', mode: 'lines', x: t, y: kb(ts.median_length_bp), name: 'median', line: { color: PALETTE[2], dash: 'dot' } },
    { type: 'scatter', mode: 'lines', x: t, y: kb(ts.p10_length_bp), name: '10th percentile', line: { color: PALETTE[3], dash: 'dash' } },
    { type: 'scatter', mode: 'lines', x: t, y: kb(ts.shortest_length_bp), name: 'shortest telomere', line: { color: PALETTE[1] } },
  ]
  const layout: Partial<Layout> = {
    ...baseLayout({ dark, title: 'Telomere length over time', xTitle: 'cell cycle', yTitle: 'length (kb)' }),
    shapes: [threshold.shape],
    annotations: threshold.annotation ? [threshold.annotation] : [],
  }
  return { data, layout: withCursor(layout, cursor) }
}

/**
 * The API's SimulationResult.to_json_dict() ships only `final_lengths_bp`
 * (no intermediate `distribution_snapshots`), so this shows the final
 * distribution -- the Streamlit page overlaid up to six snapshots when
 * record_distribution_every > 0.
 */
export function lengthDistribution(run: SimulationRun, dark: boolean): Figure {
  const vals = run.final_lengths_bp.map((v) => v / 1000)
  const data: Data[] = vals.length
    ? [
        {
          type: 'histogram',
          x: vals,
          name: `cycle ${run.config.cycles}`,
          opacity: 0.55,
          nbinsx: 40,
          marker: { color: PALETTE[0] },
        },
      ]
    : []
  const layout: Partial<Layout> = {
    ...baseLayout({ dark, title: 'Telomere length distribution', xTitle: 'length (kb)', yTitle: 'telomere count' }),
    barmode: 'overlay',
    hovermode: 'closest',
    shapes: [vline(run.config.senescence_threshold / 1000)],
  }
  return { data, layout }
}

export function senescenceCurve(run: SimulationRun, dark: boolean, cursor?: number | null): Figure {
  const ts = run.timeseries
  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: ts.cycle,
      y: ts.senescent_fraction,
      name: 'senescent fraction',
      fill: 'tozeroy',
      line: { color: PALETTE[1] },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: ts.cycle,
      y: ts.fraction_below_threshold,
      name: 'telomeres below threshold',
      line: { color: PALETTE[3], dash: 'dot' },
    },
  ]
  const base = baseLayout({ dark, title: 'Senescence over time', xTitle: 'cell cycle', yTitle: 'fraction' })
  const layout: Partial<Layout> = { ...base, yaxis: { ...base.yaxis, range: [0, 1.02] } }
  return { data, layout: withCursor(layout, cursor) }
}

/**
 * Cumulative population doublings (docs/MODEL.md §2.5). Plotted against days when the
 * run set hours_per_cycle (a timeline assumption), otherwise against the model cycle --
 * cycle is NOT a doubling count, which is why this curve exists.
 */
export function pdCurve(run: SimulationRun, dark: boolean, cursor?: number | null): Figure | null {
  const ts = run.timeseries
  const pd = ts.population_doublings
  if (!pd || pd.every((v) => v === null)) return null
  const hours = ts.time_hours
  const days = hours && hours.some((h) => h !== null) ? hours.map((h) => (h === null ? null : h / 24)) : null
  const data: Data[] = [
    { type: 'scatter', mode: 'lines', x: days ?? ts.cycle, y: pd, name: 'population doublings', line: { color: PALETTE[4], width: 2 } },
  ]
  const layout: Partial<Layout> = baseLayout({
    dark,
    title: 'Cumulative population doublings',
    xTitle: days ? 'days (assumed hours per cycle)' : 'cell cycle',
    yTitle: 'PD',
  })
  return { data, layout: days ? layout : withCursor(layout, cursor) }
}

export function populationCurve(run: SimulationRun, dark: boolean, cursor?: number | null): Figure {
  const ts = run.timeseries
  const cap = hline(run.config.carrying_capacity, 'carrying capacity')
  const data: Data[] = [
    { type: 'scatter', mode: 'lines', x: ts.cycle, y: ts.population_size, name: 'living cells', line: { color: PALETTE[0], width: 2 } },
    {
      type: 'scatter',
      mode: 'lines',
      x: ts.cycle,
      y: ts.proliferative_count,
      name: 'proliferative cells',
      line: { color: PALETTE[2] },
      fill: 'tozeroy',
    },
  ]
  const layout: Partial<Layout> = {
    ...baseLayout({ dark, title: 'Population over time', xTitle: 'cell cycle', yTitle: 'cells' }),
    shapes: [cap.shape],
    annotations: cap.annotation ? [cap.annotation] : [],
  }
  return { data, layout: withCursor(layout, cursor) }
}

export function fitnessBreakdownBar(
  breakdown: FitnessBreakdown,
  weights: FitnessWeights,
  dark: boolean,
  /** Title prefix (the Compare page shows one bar per scenario: "<name>: weighted contributions …"). */
  titlePrefix?: string,
): Figure {
  const comps: Array<[string, number]> = [
    ['survival', weights.w_survival * breakdown.survival],
    ['reserve', weights.w_reserve * breakdown.reserve],
    ['senescence', -weights.w_senescence * breakdown.senescence],
    ['instability', -weights.w_instability * breakdown.instability],
    ['cost', -weights.w_cost * breakdown.cost],
    ['genome_instability', -weights.w_genome_instability * breakdown.genome_instability],
    ['canalization', weights.w_canalization * breakdown.canalization],
  ]
  const sign = breakdown.total >= 0 ? '+' : ''
  const data: Data[] = [
    {
      type: 'bar',
      x: comps.map((c) => c[0]),
      y: comps.map((c) => c[1]),
      marker: { color: comps.map(([, v]) => (v >= 0 ? PALETTE[2] : PALETTE[1])) },
    },
  ]
  const layout: Partial<Layout> = {
    ...baseLayout({
      dark,
      title: `${titlePrefix ? `${titlePrefix}: w` : 'W'}eighted fitness contributions (total ${sign}${breakdown.total.toFixed(3)})`,
      yTitle: 'contribution',
      height: 280,
      showLegend: false,
    }),
    hovermode: 'closest',
  }
  return { data, layout }
}
