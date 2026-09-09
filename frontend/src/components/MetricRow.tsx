// st.metric-style cards (app/ui/components.py::terminal_metric_row and the
// Evolve page's result row).
export interface Metric {
  label: string
  value: string
  /** Optional signed delta shown under the value (st.metric's `delta`). */
  delta?: string
}

export function MetricRow({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6" data-testid="metric-row">
      {metrics.map((m) => (
        <div key={m.label} className="card px-4 py-3">
          <dt className="prose-muted text-xs">{m.label}</dt>
          <dd className="mt-1 font-heading text-lg font-semibold text-slate-900 dark:text-slate-50">{m.value}</dd>
          {m.delta && (
            <dd
              className={`text-xs font-medium ${
                m.delta.startsWith('-') ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {m.delta}
            </dd>
          )}
        </div>
      ))}
    </dl>
  )
}
