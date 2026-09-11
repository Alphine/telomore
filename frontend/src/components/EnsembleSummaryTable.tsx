// Per-seed terminal-metrics summary table for the ensemble / uncertainty
// visualization (ROADMAP.md candidate feature #2). Shows min/mean/max/std
// across seeds for a handful of key terminal metrics -- not per-seed fitness
// (POST /api/simulate/ensemble does not score every seed individually; see
// docs/API.md), which keeps the response light per the build brief.
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
  return METRICS.map(([key, label, unit, scale]) => {
    const values = valid
      .map((s) => s.terminal_metrics[key as keyof typeof s.terminal_metrics])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (!values.length) return { label, unit, min: null, mean: null, max: null, std: null }
    const s = stats(values)
    return { label, unit, min: s.min / scale, mean: s.mean / scale, max: s.max / scale, std: s.std / scale }
  })
}

function fmt(v: number | null, unit: string): string {
  if (v === null) return '—'
  return `${v.toFixed(unit === '%' ? 1 : 2)}${unit ? ` ${unit}` : ''}`
}

export function EnsembleSummaryTable({ series }: { series: EnsembleSeedResult[] }) {
  const rows = summaryRows(series)
  const nInvalid = series.filter((s) => !s.valid).length
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="ensemble-summary-table">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500 dark:text-slate-400">
              <th className="py-1 pr-3">Terminal metric (across seeds)</th>
              <th className="py-1 pr-3">min</th>
              <th className="py-1 pr-3">mean</th>
              <th className="py-1 pr-3">max</th>
              <th className="py-1 pr-3">std</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-1 pr-3">{r.label}</td>
                <td className="py-1 pr-3 font-mono">{fmt(r.min, r.unit)}</td>
                <td className="py-1 pr-3 font-mono">{fmt(r.mean, r.unit)}</td>
                <td className="py-1 pr-3 font-mono">{fmt(r.max, r.unit)}</td>
                <td className="py-1 pr-3 font-mono">{fmt(r.std, r.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nInvalid > 0 && (
        <p className="prose-muted text-xs">
          {nInvalid} of {series.length} seeds produced an invalid run and are excluded from these statistics.
        </p>
      )}
    </div>
  )
}
