// Pure data transform for EnsembleSummaryTable, split into its own module so
// that file only exports the component (keeps React Fast Refresh working).
import type { EnsembleSeedResult } from '../api/types'

export interface SummaryRow {
  label: string
  unit: string
  min: number | null
  mean: number | null
  max: number | null
  std: number | null
}

/** name -> [terminal_metrics key, label, unit, scale (value is divided by this before display)] */
const METRICS: Array<[string, string, string, number]> = [
  ['final_mean_length_bp', 'Final mean length', 'kb', 1000],
  ['final_mean_shortest_bp', 'Mean shortest / cell', 'kb', 1000],
  ['final_senescent_fraction', 'Senescent fraction', '%', 0.01],
  ['normalized_survival', 'Normalized survival', '', 1],
  ['final_population_size', 'Final living cells', '', 1],
]

function stats(values: number[]): { min: number; mean: number; max: number; std: number } {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { min: Math.min(...values), mean, max: Math.max(...values), std: Math.sqrt(variance) }
}

/** Pure transform: per-seed EnsembleSeedResult[] -> one summary row per key terminal metric. */
export function summaryRows(series: EnsembleSeedResult[]): SummaryRow[] {
  const valid = series.filter((s) => s.valid)
  const rows = METRICS.map(([key, label, unit, scale]) => {
    const values = valid
      .map((s) => s.terminal_metrics[key as keyof typeof s.terminal_metrics])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (!values.length) return { label, unit, min: null, mean: null, max: null, std: null }
    const s = stats(values)
    return { label, unit, min: s.min / scale, mean: s.mean / scale, max: s.max / scale, std: s.std / scale }
  })

  // Synthetic "biological age" score (ROADMAP.md candidate feature #5) is a
  // separate top-level field (not inside terminal_metrics), so it is folded
  // in here rather than through the METRICS table above.
  const ageValues = valid
    .map((s) => s.biological_age_final)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const ageRow: SummaryRow = ageValues.length
    ? { label: 'Synthetic age index', unit: '', ...stats(ageValues) }
    : { label: 'Synthetic age index', unit: '', min: null, mean: null, max: null, std: null }

  return [...rows, ageRow]
}
