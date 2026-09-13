// Generic "named parameter-override bundle" row-list editor -- the shared
// base for a G×E study's genotype and environment editors (docs/ROADMAP.md
// 2026-09-13 follow-up). Structurally mirrors SubcloneEditor.tsx's row/
// checkbox-reveals-bounded-input pattern minus the initial_fraction/
// sum-to-1 machinery, since genotypes/environments never compete -- each is
// evaluated in its own isolated simulation.
import type { BoundsResponse, ModelConfig } from '../api/types'
import { NumberInput } from './NumberInput'
import type { OverrideRow } from './overrideListUtils'
import { addRow, removeRow, setOverride, updateRow } from './overrideListUtils'

export interface OverrideListEditorProps<T extends OverrideRow> {
  bounds: BoundsResponse
  /** The parameters this axis may override (bounds.subclone_overridable for genotypes, bounds.environment_overridable for environments). */
  overridableParams: string[]
  rows: T[]
  onChange: (rows: T[]) => void
  disabled?: boolean
  idPrefix: string
  /** "genotype" | "environment" -- used in labels, aria-labels and the add-row name prefix. */
  itemLabel: string
  /** Minimum number of rows allowed (no fraction-sum constraint here, so 1 is valid -- unlike sub-clones' >= 2). */
  minRows?: number
}

export function OverrideListEditor<T extends OverrideRow>({
  bounds,
  overridableParams,
  rows,
  onChange,
  disabled = false,
  idPrefix,
  itemLabel,
  minRows = 1,
}: OverrideListEditorProps<T>) {
  return (
    <div className="space-y-3" data-testid={`${idPrefix}-list`}>
      {rows.map((row, i) => (
        <div key={i} className="rounded border border-slate-200 p-3 dark:border-slate-800" data-testid={`${idPrefix}-row-${i}`}>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor={`${idPrefix}-name-${i}`}>
                Name
              </label>
              <input
                id={`${idPrefix}-name-${i}`}
                className="input !w-32 !py-1.5 !text-sm"
                value={row.name}
                disabled={disabled}
                onChange={(e) => onChange(updateRow(rows, i, { name: e.target.value } as Partial<T>))}
              />
            </div>
            <button
              type="button"
              className="btn-ghost !px-3 !py-1.5 !text-xs"
              disabled={disabled || rows.length <= minRows}
              onClick={() => onChange(removeRow(rows, i))}
              aria-label={`Remove ${row.name}`}
            >
              ✕ Remove
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {overridableParams.map((name) => {
              const bound = bounds.bounds[name]
              const overridden = name in row.overrides
              return (
                <label key={name} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="accent-teal-600"
                    checked={overridden}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(
                        setOverride(rows, i, name, e.target.checked ? (bounds.defaults[name as keyof ModelConfig] as number) : null),
                      )
                    }
                    aria-label={`Override ${name} for ${row.name}`}
                  />
                  <code className="font-mono">{name}</code>
                  {overridden && (
                    <NumberInput
                      className="input !w-20 !px-1.5 !py-1 text-right font-mono !text-xs"
                      aria-label={`${name} value for ${row.name}`}
                      value={row.overrides[name]}
                      min={bound.min}
                      max={bound.max}
                      step={bound.max - bound.min <= 2 ? 0.01 : 1}
                      disabled={disabled}
                      onChange={(v) => onChange(setOverride(rows, i, name, v))}
                    />
                  )}
                </label>
              )
            })}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost !px-3 !py-1 !text-xs"
        disabled={disabled}
        onClick={() => onChange(addRow(rows, itemLabel))}
      >
        + Add {itemLabel}
      </button>
    </div>
  )
}
