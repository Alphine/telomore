// Phase table of a protocol: one row per phase (with its cycle range), one
// column per scheduled parameter, and a "time average" footer. The average is
// computed from the per-cycle values that were (or would be) applied --
// `applied_schedule` from a simulation when available, else the schedule
// expanded with the same phase arithmetic -- never from a closed formula.
import type { InterventionSchedule } from '../api/types'
import { meanApplied, perCycleValues, phaseBounds } from './scheduleUtils'

export function ProtocolTable({
  schedule,
  cycles,
  applied,
  title,
}: {
  schedule: InterventionSchedule
  cycles: number
  /** SimulationRun.applied_schedule when the protocol has been simulated. */
  applied?: Record<string, number[]>
  title?: string
}) {
  const names = Object.keys(schedule.values)
  if (!names.length) return null
  const ranges = phaseBounds(Math.max(1, cycles), schedule.phases)
  const means = names.map((n) => meanApplied(applied?.[n] ?? perCycleValues(schedule.values[n], Math.max(1, cycles))))
  return (
    <div className="card overflow-x-auto">
      {title && <p className="px-3 pt-2 text-xs font-semibold">{title}</p>}
      <table className="w-full text-sm" data-testid="protocol-table">
        <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">phase</th>
            <th className="px-3 py-2">cycles</th>
            {names.map((n) => (
              <th key={n} className="px-3 py-2 text-right">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {ranges.map(([a, b], k) => (
            <tr key={k} className="border-t border-slate-200 dark:border-slate-800">
              <td className="px-3 py-1.5">{k}</td>
              <td className="px-3 py-1.5">{a < 0 ? '—' : `${a}–${b}`}</td>
              {names.map((n) => (
                <td key={n} className="px-3 py-1.5 text-right">
                  {schedule.values[n][k]?.toFixed(3) ?? ''}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-slate-300 font-semibold dark:border-slate-700">
            <td className="px-3 py-1.5 font-sans" colSpan={2}>
              time average
            </td>
            {means.map((m, i) => (
              <td key={names[i]} className="px-3 py-1.5 text-right">
                {m === null ? '' : m.toFixed(3)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
