// "Protocol phases" control shared by Evolve / Pareto / Active Learning: the
// optimizer's `schedule_phases` (1 .. bounds.max_phases, docs/MODEL.md §2.1).
// The helper copy is deliberately factual (docs/SCIENTIFIC_SCOPE.md): a
// protocol search is a bigger search space, not a stronger claim.
import { NumberInput } from './NumberInput'

export const PHASES_HELP =
  'Searches one value per phase for each free intervention gene (stress, maintenance, repair); other genes stay constant. ' +
  '1 = the classic constant-gene search. In Experiment E, with stress free to evolve like any other gene, a 6-phase ' +
  'protocol did not beat a constant dose — see docs/EXPERIMENT_PROTOCOL.md §10. Timing matters more when stress is a ' +
  'fixed condition instead (locked, not a free gene) and only the response can adapt to it — see Experiment G, §12.'

export function PhasesControl({
  id,
  value,
  max,
  onChange,
  disabled,
}: {
  id: string
  value: number
  max: number
  onChange: (phases: number) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        Protocol phases (1–{max})
      </label>
      <NumberInput
        id={id}
        className="input !w-28 !py-1.5 font-mono !text-sm"
        value={value}
        min={1}
        max={max}
        step={1}
        disabled={disabled}
        onChange={(v) => onChange(Math.min(max, Math.max(1, Math.round(v))))}
      />
      <p className="prose-muted mt-1 text-xs">{PHASES_HELP}</p>
    </div>
  )
}
