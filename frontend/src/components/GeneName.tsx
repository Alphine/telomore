// Renders a genome key: `maintenance_rate@3` -> "maintenance_rate" + a muted
// "phase 3" tag, plain genes unchanged (evolution/genome.py naming).
import { splitGeneName } from './scheduleUtils'

export function GeneName({ gene }: { gene: string }) {
  const { parameter, phase } = splitGeneName(gene)
  if (phase === null) return <>{gene}</>
  return (
    <>
      {parameter}{' '}
      <span className="rounded bg-slate-100 px-1 py-0.5 font-sans text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        phase {phase}
      </span>
    </>
  )
}
