// "Protocol (schedule)" editor for ModelConfig.schedule (docs/MODEL.md §2.1):
// per schedulable parameter a "vary over time" toggle, one shared phase count
// (1 .. bounds.max_phases) and, for every scheduled parameter, one bounded
// number input per phase. Emits the config with `schedule` shaped exactly like
// ModelConfig.to_dict() (scheduleUtils.withSchedule) or without the key when
// nothing is scheduled. Everything about bounds / names / the phase cap comes
// from GET /api/meta/bounds -- nothing is hardcoded here.
import type { BoundsResponse, ModelConfig } from '../api/types'
import { NumberInput } from './NumberInput'
import { buildSchedule, isScheduled, phaseBounds, resizePhases, withSchedule } from './scheduleUtils'

export interface ScheduleEditorProps {
  bounds: BoundsResponse
  value: ModelConfig
  onChange: (next: ModelConfig) => void
  /** Parameters that cannot be scheduled right now (e.g. derived from the chip mapper), with the reason. */
  unavailable?: ReadonlyMap<string, string>
  /** Named preset configs to offer as one-click loads (bounds.presets); `onLoadPreset` receives the full config. */
  onLoadPreset?: (name: string, config: ModelConfig) => void
  disabled?: boolean
  idPrefix?: string
}

const PRESET_LABELS: Record<string, string> = { demo_fasting: 'Load fasting demo' }

export function ScheduleEditor({
  bounds,
  value,
  onChange,
  unavailable,
  onLoadPreset,
  disabled = false,
  idPrefix = 'sched',
}: ScheduleEditorProps) {
  const schedule = value.schedule ?? null
  const values: Record<string, number[]> = schedule?.values ?? {}
  const phases = schedule?.phases ?? 2
  const scheduled = isScheduled(value)
  const ranges = phaseBounds(Math.max(1, value.cycles), phases)

  function emit(nextPhases: number, nextValues: Record<string, number[]>) {
    onChange(withSchedule(value, buildSchedule(nextPhases, nextValues)))
  }

  function toggle(name: string, on: boolean) {
    const next = { ...values }
    if (on) next[name] = resizePhases([], phases, Number(value[name as keyof ModelConfig]))
    else delete next[name]
    emit(phases, next)
  }

  function setPhases(k: number) {
    const clamped = Math.min(bounds.max_phases, Math.max(1, Math.round(k)))
    const next: Record<string, number[]> = {}
    for (const [name, vals] of Object.entries(values)) next[name] = resizePhases(vals, clamped, vals[0] ?? 0)
    emit(clamped, next)
  }

  function setValue(name: string, k: number, v: number) {
    const vals = [...(values[name] ?? [])]
    vals[k] = v
    emit(phases, { ...values, [name]: vals })
  }

  const presets = Object.entries(bounds.presets ?? {})

  return (
    <fieldset className="space-y-3" data-testid="schedule-editor">
      <legend className="mb-2 text-sm font-semibold">Protocol (schedule)</legend>
      <p className="prose-muted text-xs">
        Optionally let an intervention knob vary over the run as <em>K</em> equal phases (piecewise constant). The slider
        above then only sets the phase-0 value; the intervention cost is charged on the time-averaged dose.
      </p>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {bounds.schedulable.map((name) => {
          const reason = unavailable?.get(name)
          return (
            <label key={name} className="flex items-center gap-1.5 text-sm" title={reason}>
              <input
                type="checkbox"
                className="accent-teal-600"
                checked={name in values}
                disabled={disabled || Boolean(reason)}
                onChange={(e) => toggle(name, e.target.checked)}
                aria-label={`Vary ${name} over time`}
              />
              <code className="font-mono text-xs">{name}</code>
              {reason && <span className="prose-muted text-[10px]">({reason})</span>}
            </label>
          )
        })}
      </div>

      {scheduled && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor={`${idPrefix}-phases`}>
                Phases (1–{bounds.max_phases})
              </label>
              <NumberInput
                id={`${idPrefix}-phases`}
                className="input !w-24 !py-1.5 font-mono !text-sm"
                value={phases}
                min={1}
                max={bounds.max_phases}
                step={1}
                disabled={disabled}
                onChange={setPhases}
              />
            </div>
            <p className="prose-muted pb-1 text-xs">
              {value.cycles} cycles → phases of{' '}
              {ranges.map(([a, b]) => (a < 0 ? 0 : b - a + 1)).join(', ')} cycles.
            </p>
          </div>

          <div className="space-y-3">
            {Object.keys(values).map((name) => {
              const bound = bounds.bounds[name]
              const step = bound.max - bound.min <= 2 ? 0.01 : 1
              return (
                <div key={name} data-testid={`schedule-row-${name}`}>
                  <p className="label !mb-1">
                    {bound.label} <span className="prose-muted font-normal">per phase ({bound.unit})</span>
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {values[name].map((v, k) => (
                      <div key={k}>
                        <span className="prose-muted block text-[10px]">
                          {k}: {ranges[k] && ranges[k][0] >= 0 ? `${ranges[k][0]}–${ranges[k][1]}` : '—'}
                        </span>
                        <NumberInput
                          className="input !px-1.5 !py-1 text-right font-mono !text-xs"
                          aria-label={`${name} phase ${k}`}
                          value={v}
                          min={bound.min}
                          max={bound.max}
                          step={step}
                          disabled={disabled}
                          onChange={(nv) => setValue(name, k, nv)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {onLoadPreset &&
          presets.map(([name, cfg]) => (
            <button
              key={name}
              type="button"
              className="btn-ghost !px-3 !py-1 !text-xs"
              disabled={disabled}
              onClick={() => onLoadPreset(name, cfg)}
              title={`configs/${name}.yaml`}
            >
              {PRESET_LABELS[name] ?? `Load ${name}`}
            </button>
          ))}
        {scheduled && (
          <button
            type="button"
            className="btn-ghost !px-3 !py-1 !text-xs"
            disabled={disabled}
            onClick={() => emit(phases, {})}
          >
            Reset to constant
          </button>
        )}
      </div>
      <p className="prose-muted text-xs">
        A protocol is a sequence of model parameters, not a dosing regimen. In Experiment E an evolved 6-phase protocol did
        not beat the best constant dose (docs/EXPERIMENT_PROTOCOL.md §10).
      </p>
    </fieldset>
  )
}
