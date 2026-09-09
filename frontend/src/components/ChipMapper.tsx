// Port of app/ui/controls.py::chip_controls: organ-on-chip condition inputs
// -> derived simulation parameters via POST /api/meta/chip-to-params
// (telomere_lab.adapters.chip.chip_to_model_params runs server-side; the
// mapping coefficients are not duplicated here).
import { useEffect, useRef, useState } from 'react'

import { chipToParams } from '../api/endpoints'
import type { ChipConditions, ChipParams } from '../api/types'
import { CHIP_DEFAULTS, CHIP_FIELDS } from './chipFields'

export interface ChipMapperProps {
  /** Receives the derived overrides (or null while loading / on error). */
  onDerived: (params: ChipParams | null) => void
  disabled?: boolean
}

export function ChipMapper({ onDerived, disabled = false }: ChipMapperProps) {
  const [chip, setChip] = useState<ChipConditions>(CHIP_DEFAULTS)
  const [derived, setDerived] = useState<ChipParams | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Latest callback without re-triggering the debounce effect below.
  const onDerivedRef = useRef(onDerived)
  useEffect(() => {
    onDerivedRef.current = onDerived
  })

  // Debounced server call whenever a condition changes.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      chipToParams(chip)
        .then((p) => {
          if (cancelled) return
          setDerived(p)
          setError(null)
          onDerivedRef.current(p)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : 'Could not derive parameters.')
          onDerivedRef.current(null)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chip])

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
      <p className="text-xs text-amber-900 dark:text-amber-100">
        Derived simulation parameters. The mapping is a documented modelling assumption, not a calibrated
        relationship (docs/MODEL.md §6).
      </p>
      {CHIP_FIELDS.map((f) => {
        const id = `chip-${f.key}`
        return (
          <div key={f.key}>
            <label className="label flex items-baseline justify-between !text-xs" htmlFor={id}>
              <span>{f.label}</span>
              <span className="font-mono">{chip[f.key]}</span>
            </label>
            <input
              id={id}
              type="range"
              className="w-full accent-amber-600"
              min={f.min}
              max={f.max}
              step={f.step}
              value={chip[f.key]}
              disabled={disabled}
              onChange={(e) => setChip((c) => ({ ...c, [f.key]: Number(e.target.value) }))}
            />
          </div>
        )
      })}
      <div className="text-xs" data-testid="chip-derived">
        <div className="mb-1 font-semibold">Derived simulation parameters</div>
        {error ? (
          <span className="text-rose-700 dark:text-rose-300">{error}</span>
        ) : derived ? (
          <dl className="grid grid-cols-3 gap-2 font-mono">
            <div>
              <dt className="prose-muted">stress_level</dt>
              <dd>{derived.stress_level.toFixed(3)}</dd>
            </div>
            <div>
              <dt className="prose-muted">repair_rate</dt>
              <dd>{derived.repair_rate.toFixed(3)}</dd>
            </div>
            <div>
              <dt className="prose-muted">cycles</dt>
              <dd>{derived.cycles}</dd>
            </div>
          </dl>
        ) : (
          <span className="prose-muted">deriving…</span>
        )}
      </div>
    </div>
  )
}
