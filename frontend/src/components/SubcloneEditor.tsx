// "Sub-clone competition" editor for ModelConfig.subclones (docs/MODEL.md
// §2.2): a toggle to enable it, add/remove named clone rows, a running
// total-fraction indicator, and per-clone overridable-parameter fields from
// bounds.subclone_overridable. Structurally mirrors ScheduleEditor.tsx.
import type { BoundsResponse, ModelConfig, SubcloneSpec } from '../api/types'
import { NumberInput } from './NumberInput'
import {
  addClone,
  defaultClones,
  fractionSum,
  fractionsAreValid,
  hasSubclones,
  removeClone,
  setOverride,
  updateClone,
  withSubclones,
} from './subclonesUtils'

export interface SubcloneEditorProps {
  bounds: BoundsResponse
  value: ModelConfig
  onChange: (next: ModelConfig) => void
  disabled?: boolean
  idPrefix?: string
}

export function SubcloneEditor({ bounds, value, onChange, disabled = false, idPrefix = 'clone' }: SubcloneEditorProps) {
  const enabled = hasSubclones(value)
  const clones = value.subclones ?? []
  const total = fractionSum(clones)
  const valid = fractionsAreValid(clones)

  function setClones(next: SubcloneSpec[]) {
    onChange(withSubclones(value, next.length ? next : null))
  }

  function toggle(on: boolean) {
    setClones(on ? defaultClones() : [])
  }

  return (
    <fieldset className="space-y-3" data-testid="subclone-editor">
      <legend className="mb-2 text-sm font-semibold">Sub-clone competition</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 accent-teal-600"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => toggle(e.target.checked)}
          aria-label="Enable sub-clone competition"
        />
        <span>
          Split the founding population into named, genetically distinct clones that compete for the same
          carrying-capacity slots. Clones share the culture's stress/maintenance/repair schedule; only their own
          per-cell parameters differ.
        </span>
      </label>

      {enabled && (
        <>
          <div className="space-y-3">
            {clones.map((clone, i) => (
              <div key={i} className="rounded border border-slate-200 p-3 dark:border-slate-800" data-testid={`clone-row-${i}`}>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="label" htmlFor={`${idPrefix}-name-${i}`}>
                      Name
                    </label>
                    <input
                      id={`${idPrefix}-name-${i}`}
                      className="input !w-32 !py-1.5 !text-sm"
                      value={clone.name}
                      disabled={disabled}
                      onChange={(e) => setClones(updateClone(clones, i, { name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`${idPrefix}-frac-${i}`}>
                      Initial fraction
                    </label>
                    <NumberInput
                      id={`${idPrefix}-frac-${i}`}
                      className="input !w-24 !py-1.5 font-mono !text-sm"
                      value={clone.initial_fraction}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={disabled}
                      onChange={(v) => setClones(updateClone(clones, i, { initial_fraction: v }))}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-1.5 !text-xs"
                    disabled={disabled || clones.length <= 2}
                    onClick={() => setClones(removeClone(clones, i))}
                    aria-label={`Remove ${clone.name}`}
                  >
                    ✕ Remove
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                  {bounds.subclone_overridable.map((name) => {
                    const bound = bounds.bounds[name]
                    const overridden = name in clone.overrides
                    return (
                      <label key={name} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="accent-teal-600"
                          checked={overridden}
                          disabled={disabled}
                          onChange={(e) =>
                            setClones(
                              setOverride(clones, i, name, e.target.checked ? (value[name as keyof ModelConfig] as number) : null),
                            )
                          }
                          aria-label={`Override ${name} for ${clone.name}`}
                        />
                        <code className="font-mono">{name}</code>
                        {overridden && (
                          <NumberInput
                            className="input !w-20 !px-1.5 !py-1 text-right font-mono !text-xs"
                            aria-label={`${name} value for ${clone.name}`}
                            value={clone.overrides[name]}
                            min={bound.min}
                            max={bound.max}
                            step={bound.max - bound.min <= 2 ? 0.01 : 1}
                            disabled={disabled}
                            onChange={(v) => setClones(setOverride(clones, i, name, v))}
                          />
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" disabled={disabled} onClick={() => setClones(addClone(clones))}>
              + Add clone
            </button>
            <p className={`text-xs ${valid ? 'prose-muted' : 'font-semibold text-red-600 dark:text-red-400'}`} role={valid ? undefined : 'alert'}>
              Total initial fraction: {total.toFixed(3)}
              {!valid && ' — must sum to 1.0'}
            </p>
          </div>
          <p className="prose-muted text-xs">
            A clone is an abstract parameter variant, not a real genetic/mutation model (docs/SCIENTIFIC_SCOPE.md). The
            shared schedule (if any) applies uniformly to every clone; overriding maintenance_rate/repair_rate on a
            clone gives it its own constant value instead, ignoring the schedule for that parameter on that clone
            only (docs/MODEL.md §2.2).
          </p>
        </>
      )}
    </fieldset>
  )
}
