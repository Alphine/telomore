// Port of app/pages/06_Sensitivity.py on top of the job-polling contract
// (POST /api/sensitivity -> GET /api/jobs/{id}). No Stop button: the API has
// no cooperative cancellation for sensitivity runs (docs/API.md).
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../../api/client'
import { startSensitivity } from '../../api/endpoints'
import type { ModelConfig, ParameterSensitivity, SensitivityConfig, SensitivityResult } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { useJob } from '../../api/useJob'
import { BaselineSummary } from '../../components/BaselineSummary'
import { Callout } from '../../components/Callout'
import { CheckboxGroup } from '../../components/CheckboxGroup'
import { MetricRow } from '../../components/MetricRow'
import { PageHeader } from '../../components/PageHeader'
import { ProgressBar } from '../../components/ProgressBar'
import { InterpretPanel } from '../../components/InterpretPanel'
import { Provenance } from '../../components/Provenance'
import { loadBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { sortBySwing, tornadoChart } from '../../components/charts/sensitivityCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, rowsCsv } from '../../components/download'
import { parseIntList, signed } from '../../components/handoff'
import { FEATURES } from '../../features'
import { useActiveJobOfKind } from '../../jobs/useActiveJobs'

const FEATURE = FEATURES.find((f) => f.path === '/sensitivity')!

// telomere_lab.schemas.SensitivityConfig defaults (no sensitivity_default in
// GET /api/meta/bounds; the API fills omitted fields with the same values).
const DEFAULT_FRACTION = 0.1
const DEFAULT_SEEDS = '1,2,3'

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(4))

function SensitivityTable({ items }: { items: ParameterSensitivity[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm" data-testid="sensitivity-table">
        <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">parameter</th>
            <th className="px-3 py-2 text-right">low value</th>
            <th className="px-3 py-2 text-right">baseline value</th>
            <th className="px-3 py-2 text-right">high value</th>
            <th className="px-3 py-2 text-right">fitness_low</th>
            <th className="px-3 py-2 text-right">fitness_baseline</th>
            <th className="px-3 py-2 text-right">fitness_high</th>
            <th className="px-3 py-2 text-right">swing</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {items.map((it) => (
            <tr key={it.parameter} className="border-t border-slate-200 dark:border-slate-800">
              <td className="px-3 py-1.5">{it.parameter}</td>
              <td className="px-3 py-1.5 text-right">{it.low_value.toFixed(3)}</td>
              <td className="px-3 py-1.5 text-right">{it.baseline_value.toFixed(3)}</td>
              <td className="px-3 py-1.5 text-right">{it.high_value.toFixed(3)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.fitness_low)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.fitness_baseline)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.fitness_high)}</td>
              <td className="px-3 py-1.5 text-right">{it.swing === null ? 'n/a' : signed(it.swing, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Sensitivity() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  const [params, setParams] = useState<string[] | null>(null)
  const [fraction, setFraction] = useState(DEFAULT_FRACTION)
  const [seedsText, setSeedsText] = useState(DEFAULT_SEEDS)
  const [base, setBase] = useState<ModelConfig | null>(null)
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<SensitivityConfig | null>(null)
  const [live, setLive] = useState<ParameterSensitivity[]>([])

  // Re-adopt an in-flight job of our own kind -- navigating away and back
  // must resume live progress, not reset to the idle form.
  const activeSensitivityJob = useActiveJobOfKind('sensitivity')
  const effectiveJobId = jobId ?? activeSensitivityJob?.job_id ?? null

  const { job, error: jobError, isActive } = useJob<ParameterSensitivity, SensitivityResult>(effectiveJobId)

  const baseline = base ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)
  const parameters = params ?? bounds?.evolvable ?? []

  // One progress payload per finished parameter -> live table.
  const progress = job?.progress ?? null
  if (progress && !live.some((r) => r.parameter === progress.parameter)) {
    setLive([...live, progress])
  }

  const result = job?.status === 'completed' ? job.result : null
  const items = useMemo(() => sortBySwing(result?.items ?? live), [result, live])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!bounds || !baseline) return
    setFormError(null)
    const seeds = parseIntList(seedsText)
    if (seeds === null) {
      setFormError('Seeds must be integers.')
      return
    }
    if (parameters.length === 0) {
      setFormError('Select at least one parameter to test.')
      return
    }
    const sensitivity: SensitivityConfig = {
      parameters,
      perturbation_fraction: fraction,
      eval_seeds: seeds.length ? seeds : [1, 2, 3],
      weights: bounds.fitness_weights_default,
    }
    setSubmitting(true)
    try {
      const { job_id } = await startSensitivity({ model: baseline, sensitivity, notes })
      setLive([])
      setSubmitted(sensitivity)
      setJobId(job_id)
    } catch (err: unknown) {
      if (err instanceof ApiError) setFormError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setFormError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setSubmitting(false)
    }
  }

  const tornado = useMemo(
    () => (items.length ? tornadoChart(items, submitted?.perturbation_fraction ?? fraction, dark) : null),
    [items, submitted, fraction, dark],
  )

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />
      <p className="text-sm leading-relaxed">
        <strong>One-at-a-time (OAT) sensitivity.</strong> Each parameter is perturbed +/- a fraction of its allowed range
        while every other parameter stays at the baseline; the fitness swing (high − low) shows how much that single knob
        matters here, holding everything else fixed. It does <strong>not</strong> capture interactions between parameters —
        for that, see the <strong>Pareto</strong> and <strong>Evolve</strong> pages.
      </p>

      {boundsError && (
        <Callout tone="error" role="alert">
          Could not load parameter bounds: {boundsError}
        </Callout>
      )}
      {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}

      {bounds && baseline && (
        <form onSubmit={onSubmit} className="space-y-6">
          <BaselineSummary bounds={bounds} value={baseline} onChange={setBase} disabled={isActive} idPrefix="sens-base" />

          <section className="card space-y-4 p-5">
            <CheckboxGroup
              legend="Parameters to test"
              options={bounds.evolvable}
              value={parameters}
              disabled={isActive}
              onChange={setParams}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label flex items-baseline justify-between" htmlFor="sens-frac">
                  <span>Perturbation (+/- fraction of range)</span>
                  <span className="font-mono text-xs">{fraction.toFixed(2)}</span>
                </label>
                <input
                  id="sens-frac"
                  type="range"
                  className="w-full accent-teal-600"
                  min={0.02}
                  max={0.3}
                  step={0.01}
                  value={fraction}
                  disabled={isActive}
                  onChange={(e) => setFraction(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="label" htmlFor="sens-seeds">
                  Simulator seeds to average (comma-separated)
                </label>
                <input
                  id="sens-seeds"
                  className="input font-mono !text-sm"
                  value={seedsText}
                  disabled={isActive}
                  onChange={(e) => setSeedsText(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="sens-notes">
                Notes for the ledger
              </label>
              <input id="sens-notes" className="input" value={notes} disabled={isActive} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>

          {formError && (
            <Callout tone="error" role="alert">
              {formError}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={submitting || isActive}>
              {submitting ? 'Starting…' : '📐 Run sensitivity analysis'}
            </button>
            {isActive && (
              <span className="prose-muted text-xs">
                Runs to completion once started (the API has no stop for sensitivity sweeps).
              </span>
            )}
          </div>
        </form>
      )}

      {/* ---------------------------------------------------- live progress */}
      {effectiveJobId && isActive && (
        <section className="card space-y-3 p-5" role="status" aria-live="polite">
          {(() => {
            const n = submitted?.parameters.length ?? 0
            const rec = job?.progress ?? null
            return (
              <ProgressBar
                fraction={n > 0 ? live.length / n : 0}
                text={
                  rec
                    ? `${rec.parameter}: swing ${rec.swing === null ? 'n/a' : signed(rec.swing, 4)} (${live.length}/${n})`
                    : job?.status === 'running'
                      ? 'Evaluating the baseline…'
                      : 'Queued…'
                }
              />
            )
          })()}
          {items.length > 0 && <SensitivityTable items={items} />}
          {jobError && (
            <Callout tone="warning" role="alert">
              Polling problem: {jobError}
            </Callout>
          )}
        </section>
      )}

      {job?.status === 'failed' && (
        <Callout tone="error" role="alert">
          The sensitivity job failed: {job.error ?? 'unknown error'}
        </Callout>
      )}

      {!effectiveJobId && bounds && (
        <Callout tone="info">
          Choose parameters and press <strong>Run sensitivity analysis</strong>.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {result && (
        <section className="space-y-6" aria-label="Sensitivity results">
          <MetricRow
            metrics={[
              { label: 'Baseline fitness', value: result.baseline_fitness === null ? 'n/a' : signed(result.baseline_fitness) },
              { label: 'Parameters tested', value: String(result.items.length) },
              { label: 'Simulations run', value: String(result.evaluations) },
              { label: 'Runtime', value: `${result.runtime_seconds.toFixed(1)} s` },
            ]}
          />
          {result.run_id && <Provenance runId={result.run_id} />}
          {result.run_id && <InterpretPanel runId={result.run_id} />}
          {tornado && <Plot figure={tornado} />}

          <div>
            <h3 className="mb-2 text-base font-semibold">Sensitivity table (sorted by |swing|)</h3>
            <SensitivityTable items={items} />
          </div>

          <div>
            <h3 className="mb-2 text-base font-semibold">Export</h3>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => downloadJson(`${result.run_id ?? 'sensitivity'}.json`, result)}>
                ⬇ Sensitivity result (JSON)
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  downloadText(
                    `${result.run_id ?? 'sensitivity'}.csv`,
                    rowsCsv(
                      items.map((it) => ({
                        parameter: it.parameter,
                        fitness_low: it.fitness_low,
                        fitness_baseline: it.fitness_baseline,
                        fitness_high: it.fitness_high,
                        swing: it.swing,
                      })),
                    ),
                    'text/csv',
                  )
                }
              >
                ⬇ Sensitivity table (CSV)
              </button>
            </div>
            <p className="prose-muted mt-2 text-xs">
              A large swing means fitness is sensitive to that parameter <em>around this baseline</em> — it is not a global
              ranking and ignores interactions between parameters.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
