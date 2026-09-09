import { Link } from 'react-router-dom'

import type { BoundsResponse, ModelConfig } from '../api/types'
import { ModelConfigForm } from './ModelConfigForm'

/**
 * The "Baseline: stress … · repair … · N cycles · seed S. Change it on the
 * Simulate page." caption of the Pareto / Sensitivity / Active Learning
 * pages, plus the collapsible ModelConfigForm the Evolve port added so the
 * baseline can also be edited in place.
 */
export function BaselineSummary({
  bounds,
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  bounds: BoundsResponse
  value: ModelConfig
  onChange: (next: ModelConfig) => void
  disabled: boolean
  idPrefix: string
}) {
  return (
    <>
      <p className="prose-muted" data-testid="baseline-summary">
        Baseline: stress {value.stress_level.toFixed(2)} · maintenance {value.maintenance_rate.toFixed(2)} · repair{' '}
        {value.repair_rate.toFixed(2)} · {value.cycles} cycles · seed {value.seed}. Change it on the{' '}
        <Link className="link" to="/simulate">
          Simulate
        </Link>{' '}
        page with <em>Set as baseline</em>, or edit it below.
      </p>
      <details className="card p-5">
        <summary className="cursor-pointer select-none text-sm font-semibold">Baseline model parameters</summary>
        <div className="mt-4 max-w-xl">
          <ModelConfigForm bounds={bounds} value={value} onChange={onChange} idPrefix={idPrefix} disabled={disabled} />
        </div>
      </details>
    </>
  )
}
