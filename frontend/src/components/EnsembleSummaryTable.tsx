// Per-seed terminal-metrics summary table for the ensemble / uncertainty
// visualization (ROADMAP.md candidate feature #2). Shows min/mean/max/std
// across seeds for a handful of key terminal metrics -- not per-seed fitness
// (POST /api/simulate/ensemble does not score every seed individually; see
// docs/API.md), which keeps the response light per the build brief.
import type { EnsembleSeedResult } from '../api/types'
import { summaryRows } from './ensembleSummaryUtils'

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
