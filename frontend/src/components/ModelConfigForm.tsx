// Port of app/ui/controls.py::model_controls. Every bounded parameter reads
// its min/max/label/unit/description from GET /api/meta/bounds
// (PARAMETER_BOUNDS) -- nothing about a model bound is hardcoded here.
import { useState } from 'react'

import type { BoundsResponse, ModelConfig, ParameterBound } from '../api/types'
import { NumberInput } from './NumberInput'

// Parameters the Streamlit sliders showed in kb (stored in bp).
const KB_FIELDS: ReadonlySet<keyof ModelConfig> = new Set(['initial_length', 'senescence_threshold'] as const)

// Widget ranges for the structural / run-control fields that are NOT in
// PARAMETER_BOUNDS (the model only validates them relationally, e.g.
// carrying_capacity >= population_size >= 1, cycles >= 1). Copied from the
// st.number_input calls in app/ui/controls.py; they are UI conveniences, not
// model bounds -- the server-side ModelConfig.validate() is the authority.
const RUN_RANGES: Record<string, { min: number; max: number; step: number; label: string; help?: string }> = {
  population_size: { min: 10, max: 2000, step: 10, label: 'Founding cells' },
  carrying_capacity: { min: 1, max: 5000, step: 50, label: 'Carrying capacity' },
  cycles: { min: 5, max: 600, step: 5, label: 'Cycles' },
  seed: { min: 0, max: 2 ** 31 - 1, step: 1, label: 'Random seed' },
  telomeres_per_cell: {
    min: 2,
    max: 92,
    step: 2,
    label: 'Telomeres per cell',
    help: 'Human cells have 92 telomere ends; the MVP default (32) trades realism for speed.',
  },
  record_distribution_every: { min: 0, max: 200, step: 5, label: 'Snapshot distribution every N cycles (0 = final only)' },
}

export interface ModelConfigFormProps {
  bounds: BoundsResponse
  value: ModelConfig
  onChange: (next: ModelConfig) => void
  /** Fields shown read-only (e.g. derived from organ-on-chip conditions). */
  locked?: ReadonlySet<keyof ModelConfig>
  idPrefix?: string
  disabled?: boolean
}

function BoundedField({
  name,
  bound,
  value,
  onChange,
  locked,
  disabled,
  id,
}: {
  name: keyof ModelConfig
  bound: ParameterBound
  value: number
  onChange: (v: number) => void
  locked: boolean
  disabled: boolean
  id: string
}) {
  const kb = KB_FIELDS.has(name)
  const scale = kb ? 1000 : 1
  const lo = bound.min / scale
  const hi = bound.max / scale
  // Same step rule as controls.py::_slider.
  const step = kb ? 0.1 : bound.max - bound.min <= 2 ? 0.01 : 1
  const shown = value / scale
  const off = locked || disabled
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="label !mb-0" htmlFor={id} title={bound.description}>
          {bound.label} ({kb ? 'kb' : bound.unit})
        </label>
        {locked && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
            derived from chip
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          className="flex-1 accent-teal-600 disabled:opacity-50"
          min={lo}
          max={hi}
          step={step}
          value={shown}
          disabled={off}
          onChange={(e) => onChange(Number(e.target.value) * scale)}
          aria-label={`${bound.label} slider`}
        />
        <NumberInput
          id={id}
          className="input !w-24 !py-1 text-right font-mono !text-xs"
          value={Number(shown.toFixed(kb ? 2 : 4))}
          min={lo}
          max={hi}
          step={step}
          disabled={off}
          onChange={(v) => onChange(v * scale)}
        />
      </div>
      <p className="prose-muted mt-0.5 text-xs">{bound.description}</p>
    </div>
  )
}

function RunField({
  name,
  value,
  onChange,
  min,
  disabled,
  locked,
  id,
}: {
  name: string
  value: number
  onChange: (v: number) => void
  min?: number
  disabled: boolean
  locked: boolean
  id: string
}) {
  const r = RUN_RANGES[name]
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="label" htmlFor={id} title={r.help}>
          {r.label}
        </label>
        {locked && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
            derived from chip
          </span>
        )}
      </div>
      <NumberInput
        id={id}
        className="input !py-1.5 font-mono !text-sm"
        value={value}
        min={min ?? r.min}
        max={r.max}
        step={r.step}
        disabled={disabled || locked}
        onChange={(v) => onChange(Math.round(v))}
      />
      {r.help && <p className="prose-muted mt-0.5 text-xs">{r.help}</p>}
    </div>
  )
}

export function ModelConfigForm({ bounds, value, onChange, locked, idPrefix = 'model', disabled = false }: ModelConfigFormProps) {
  const [warning, setWarning] = useState<string | null>(null)
  const isLocked = (k: keyof ModelConfig) => Boolean(locked?.has(k))
  const id = (k: string) => `${idPrefix}-${k}`

  function set<K extends keyof ModelConfig>(key: K, v: ModelConfig[K]) {
    const next: ModelConfig = { ...value, [key]: v }
    let note: string | null = null
    // Same relational fixes as controls.py::model_controls.
    if (next.senescence_threshold >= next.initial_length) {
      next.senescence_threshold = Math.round(next.initial_length * 0.8)
      note = 'Senescence threshold must be below the initial length; clamped to 80 % of it.'
    }
    if (next.carrying_capacity < next.population_size) next.carrying_capacity = next.population_size
    setWarning(note)
    onChange(next)
  }

  const bounded = (name: keyof ModelConfig) => (
    <BoundedField
      key={name}
      name={name}
      bound={bounds.bounds[name]}
      value={value[name] as number}
      onChange={(v) => set(name, v as ModelConfig[typeof name])}
      locked={isLocked(name)}
      disabled={disabled}
      id={id(name)}
    />
  )
  const run = (name: keyof ModelConfig, min?: number) => (
    <RunField
      key={name}
      name={name}
      value={value[name] as number}
      onChange={(v) => set(name, v as ModelConfig[typeof name])}
      min={min}
      disabled={disabled}
      locked={isLocked(name)}
      id={id(name)}
    />
  )

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold">Initial conditions</legend>
        {bounded('initial_length')}
        {bounded('senescence_threshold')}
        {warning && (
          <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
            {warning}
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold">Dynamics</legend>
        {bounded('shortening_rate')}
        {bounded('stress_level')}
        {bounded('maintenance_rate')}
        {bounded('repair_rate')}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold">Population &amp; run</legend>
        <div className="grid grid-cols-2 gap-3">
          {run('population_size')}
          {run('carrying_capacity', value.population_size)}
          {run('cycles')}
          {run('seed')}
        </div>
      </fieldset>

      <details className="group">
        <summary className="cursor-pointer select-none text-sm font-semibold">Advanced model parameters</summary>
        <div className="mt-3 space-y-3">
          {bounded('initial_length_sd')}
          {bounded('stress_sensitivity')}
          {bounded('maintenance_max_gain')}
          {bounded('noise_sd')}
          {bounded('senescent_death_rate')}
          <div className="grid grid-cols-2 gap-3">
            {run('telomeres_per_cell')}
            {run('record_distribution_every')}
          </div>
        </div>
      </details>
    </div>
  )
}
