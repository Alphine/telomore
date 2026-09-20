// Port of app/pages/07_ActiveLearning.py on top of the job-polling contract
// (POST /api/active-learning -> GET /api/jobs/{id}). No Stop button: the API
// has no cooperative cancellation for the GP-refit loop (docs/API.md).
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../../api/client'
import { startActiveLearning } from '../../api/endpoints'
import type { ActiveLearningConfig, ActiveLearningRecord, ActiveLearningResult, ModelConfig } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { useJob } from '../../api/useJob'
import { BaselineSummary } from '../../components/BaselineSummary'
import { Callout } from '../../components/Callout'
import { CheckboxGroup } from '../../components/CheckboxGroup'
import { MetricRow } from '../../components/MetricRow'
import { NumberInput } from '../../components/NumberInput'
import { PageHeader } from '../../components/PageHeader'
import { PhasesControl } from '../../components/PhasesControl'
import { ProgressBar } from '../../components/ProgressBar'
import { ProtocolTable } from '../../components/ProtocolTable'
import { InterpretPanel } from '../../components/InterpretPanel'
import { Provenance } from '../../components/Provenance'
import { loadBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { convergenceChart } from '../../components/charts/activeLearningCharts'
import { appliedScheduleChart, scheduleToApplied } from '../../components/charts/scheduleCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, rowsCsv } from '../../components/download'
import { genomeToConfig, parseIntList, signed } from '../../components/handoff'
import { isScheduled } from '../../components/scheduleUtils'
import { FEATURES } from '../../features'
import { useActiveJobOfKind } from '../../jobs/useActiveJobs'
import { usePersistentState } from '../../state/usePersistentState'

const FEATURE = FEATURES.find((f) => f.path === '/active-learning')!

// telomere_lab.schemas.ActiveLearningConfig defaults (no active_learning_default
// in GET /api/meta/bounds; the API fills omitted fields with the same values).
const DEFAULTS = { n_initial: 8, n_iterations: 16, seed: 11, xi: 0.01, seeds: '1,2,3' }

const fmt = (v: number | null) => (v === null ? '' : v.toFixed(4))

function IterationTable({ records }: { records: ActiveLearningRecord[] }) {
  return (
    <div className="card max-h-96 overflow-auto">
      <table className="w-full text-sm" data-testid="iteration-table">
        <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">iteration</th>
            <th className="px-3 py-2">phase</th>
            <th className="px-3 py-2 text-right">predicted_mean</th>
            <th className="px-3 py-2 text-right">predicted_std</th>
            <th className="px-3 py-2 text-right">acquisition_value</th>
            <th className="px-3 py-2 text-right">real_fitness</th>
            <th className="px-3 py-2 text-right">best_so_far</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {records.map((r) => (
            <tr key={r.iteration} className="border-t border-slate-200 dark:border-slate-800">
              <td className="px-3 py-1.5">{r.iteration}</td>
              <td className="px-3 py-1.5">{r.phase}</td>
              <td className="px-3 py-1.5 text-right">{fmt(r.predicted_mean)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(r.predicted_std)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(r.acquisition_value)}</td>
              <td className="px-3 py-1.5 text-right">{signed(r.real_fitness, 4)}</td>
              <td className="px-3 py-1.5 text-right">{signed(r.best_so_far, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ActiveLearning() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  const [freeGenes, setFreeGenes] = usePersistentState<string[]>('activelearning:freeGenes', ['stress_level', 'maintenance_rate', 'repair_rate'])
  const [nInitial, setNInitial] = usePersistentState('activelearning:nInitial', DEFAULTS.n_initial)
  const [nIterations, setNIterations] = usePersistentState('activelearning:nIterations', DEFAULTS.n_iterations)
  const [xi, setXi] = usePersistentState('activelearning:xi', DEFAULTS.xi)
  const [seed, setSeed] = usePersistentState('activelearning:seed', DEFAULTS.seed)
  const [seedsText, setSeedsText] = usePersistentState('activelearning:seedsText', DEFAULTS.seeds)
  const [schedulePhases, setSchedulePhases] = usePersistentState('activelearning:schedulePhases', 1)
  const [base, setBase] = usePersistentState<ModelConfig | null>('activelearning:base', null)
  const [notes, setNotes] = usePersistentState('activelearning:notes', '')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = usePersistentState<string | null>('activelearning:jobId', null)
  const [submitted, setSubmitted] = usePersistentState<ActiveLearningConfig | null>('activelearning:submitted', null)
  const [live, setLive] = usePersistentState<ActiveLearningRecord[]>('activelearning:live', [])

  // Re-adopt an in-flight job of our own kind -- navigating away and back
  // must resume live progress, not reset to the idle form.
  const activeActiveLearningJob = useActiveJobOfKind('active_learning')
  const effectiveJobId = jobId ?? activeActiveLearningJob?.job_id ?? null

  const { job, error: jobError, isActive } = useJob<ActiveLearningRecord, ActiveLearningResult>(effectiveJobId)

  const baseline = base ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)

  // One progress payload per real evaluation -> live table + convergence line.
  const progress = job?.progress ?? null
  if (progress && !live.some((r) => r.iteration === progress.iteration)) {
    setLive([...live, progress].sort((a, b) => a.iteration - b.iteration))
  }

  const result = job?.status === 'completed' ? job.result : null
  const records = result?.records ?? live

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!bounds || !baseline) return
    setFormError(null)
    const seeds = parseIntList(seedsText)
    if (seeds === null) {
      setFormError('Seeds must be integers.')
      return
    }
    if (freeGenes.length === 0) {
      setFormError('Select at least one free gene.')
      return
    }
    const active_learning: ActiveLearningConfig = {
      n_initial: nInitial,
      n_iterations: nIterations,
      eval_seeds: seeds.length ? seeds : [1, 2, 3],
      free_genes: freeGenes,
      seed,
      xi,
      candidate_pool_size: 500,
      schedule_phases: schedulePhases,
      weights: bounds.fitness_weights_default,
    }
    setSubmitting(true)
    try {
      const { job_id } = await startActiveLearning({ model: baseline, active_learning, notes })
      setLive([])
      setSubmitted(active_learning)
      setJobId(job_id)
    } catch (err: unknown) {
      if (err instanceof ApiError) setFormError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setFormError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setSubmitting(false)
    }
  }

  const convergence = useMemo(() => (records.length ? convergenceChart(records, dark) : null), [records, dark])
  const total = submitted ? submitted.n_initial + submitted.n_iterations : 0
  // Best genome as a full config: `<gene>@<phase>` genes form its schedule.
  const bestConfig = useMemo(() => (result && baseline ? genomeToConfig(baseline, result.best_genome) : null), [result, baseline])
  const bestProtocol = useMemo(
    () =>
      bestConfig && isScheduled(bestConfig)
        ? appliedScheduleChart(scheduleToApplied(bestConfig.schedule, bestConfig.cycles), dark, null, 'Best genome protocol (per-cycle values)')
        : null,
    [bestConfig, dark],
  )

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />
      <p className="text-sm leading-relaxed">
        <strong>Surrogate-model active learning.</strong> Instead of evaluating every candidate with the real simulator, a
        small random <em>initial design</em> is evaluated for real, a cheap Gaussian-process surrogate is fit to those
        (genome → fitness) pairs, and <strong>Expected Improvement</strong> picks which untested configuration is most
        worth the next real evaluation. Refit, repeat. The question this answers: can we reach comparable fitness with{' '}
        <strong>fewer real simulator evaluations</strong> than random search or a full population-based search (GA/NSGA-II,
        see the <strong>Evolve</strong> and <strong>Pareto</strong> pages)?
      </p>

      {boundsError && (
        <Callout tone="error" role="alert">
          Could not load parameter bounds: {boundsError}
        </Callout>
      )}
      {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}

      {bounds && baseline && (
        <form onSubmit={onSubmit} className="space-y-6">
          <BaselineSummary bounds={bounds} value={baseline} onChange={setBase} disabled={isActive} idPrefix="al-base" />

          <section className="card space-y-4 p-5">
            <CheckboxGroup
              legend="Free genes (searched by the optimizer)"
              options={bounds.evolvable}
              value={freeGenes}
              disabled={isActive}
              onChange={setFreeGenes}
            />
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="al-init">
                  Initial random design size
                </label>
                <NumberInput
                  id="al-init"
                  className="input !py-1.5 font-mono !text-sm"
                  value={nInitial}
                  min={2}
                  max={100}
                  step={1}
                  disabled={isActive}
                  onChange={(v) => setNInitial(Math.round(v))}
                />
              </div>
              <div>
                <label className="label" htmlFor="al-iter">
                  Active-learning iterations
                </label>
                <NumberInput
                  id="al-iter"
                  className="input !py-1.5 font-mono !text-sm"
                  value={nIterations}
                  min={0}
                  max={200}
                  step={1}
                  disabled={isActive}
                  onChange={(v) => setNIterations(Math.round(v))}
                />
              </div>
              <div>
                <label className="label" htmlFor="al-xi">
                  Expected Improvement margin (xi)
                </label>
                <NumberInput
                  id="al-xi"
                  className="input !py-1.5 font-mono !text-sm"
                  value={xi}
                  min={0}
                  max={0.5}
                  step={0.01}
                  disabled={isActive}
                  onChange={setXi}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="al-seeds">
                  Simulator seeds to average (comma-separated)
                </label>
                <input
                  id="al-seeds"
                  className="input font-mono !text-sm"
                  value={seedsText}
                  disabled={isActive}
                  onChange={(e) => setSeedsText(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="al-seed">
                  Optimizer random seed
                </label>
                <NumberInput
                  id="al-seed"
                  className="input !py-1.5 font-mono !text-sm"
                  value={seed}
                  min={0}
                  max={10000}
                  step={1}
                  disabled={isActive}
                  onChange={(v) => setSeed(Math.round(v))}
                />
              </div>
            </div>
            <PhasesControl id="al-phases" value={schedulePhases} max={bounds.max_phases} disabled={isActive} onChange={setSchedulePhases} />
            <div>
              <label className="label" htmlFor="al-notes">
                Notes for the ledger
              </label>
              <input id="al-notes" className="input" value={notes} disabled={isActive} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>

          {formError && (
            <Callout tone="error" role="alert">
              {formError}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={submitting || isActive}>
              {submitting ? 'Starting…' : '🧭 Run active learning'}
            </button>
            {isActive && (
              <span className="prose-muted text-xs">
                Runs to completion once started (the API has no stop for the GP-refit loop).
              </span>
            )}
          </div>
        </form>
      )}

      {/* ---------------------------------------------------- live progress */}
      {effectiveJobId && isActive && (
        <section className="card space-y-3 p-5" role="status" aria-live="polite">
          {(() => {
            const rec = job?.progress ?? null
            return (
              <ProgressBar
                fraction={total > 0 ? live.length / total : 0}
                text={
                  rec
                    ? `[${rec.phase}] real fitness ${signed(rec.real_fitness, 4)} · best so far ${signed(rec.best_so_far, 4)} (${live.length}/${total})`
                    : job?.status === 'running'
                      ? 'Evaluating the initial design…'
                      : 'Queued…'
                }
              />
            )
          })()}
          {convergence && <Plot figure={convergence} />}
          {records.length > 0 && <IterationTable records={records} />}
          {jobError && (
            <Callout tone="warning" role="alert">
              Polling problem: {jobError}
            </Callout>
          )}
        </section>
      )}

      {job?.status === 'failed' && (
        <Callout tone="error" role="alert">
          The active-learning job failed: {job.error ?? 'unknown error'}
        </Callout>
      )}

      {!effectiveJobId && bounds && (
        <Callout tone="info">
          Choose a budget and press <strong>Run active learning</strong>.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {result && submitted && (
        <section className="space-y-6" aria-label="Active learning results">
          <MetricRow
            metrics={[
              { label: 'Best fitness found', value: signed(result.best_fitness) },
              { label: 'Real simulator evaluations', value: String(result.evaluations) },
              { label: 'Initial design / iterations', value: `${submitted.n_initial} / ${submitted.n_iterations}` },
              { label: 'Runtime', value: `${result.runtime_seconds.toFixed(1)} s` },
            ]}
          />
          {result.run_id && <Provenance runId={result.run_id} />}
          {result.run_id && <InterpretPanel runId={result.run_id} />}

          <div>
            <h3 className="mb-2 text-base font-semibold">Convergence: best fitness vs. real evaluations</h3>
            {convergence && <Plot figure={convergence} />}
            <p className="prose-muted mt-2 text-xs">
              Best genome: {Object.entries(result.best_genome).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(', ')}. The
              Streamlit page also drew a random-search baseline of the same budget; the API's active-learning result does not
              include one, so it is not shown here.
            </p>
          </div>

          {bestConfig && isScheduled(bestConfig) && bestProtocol && (
            <div className="space-y-3" aria-label="Best genome protocol">
              <h3 className="text-base font-semibold">Best genome protocol ({bestConfig.schedule.phases} phases)</h3>
              <Plot figure={bestProtocol} />
              <ProtocolTable schedule={bestConfig.schedule} cycles={bestConfig.cycles} />
              <p className="prose-muted text-xs">
                One value per phase for each scheduled gene (cost charged on the time averages) — a model configuration
                under the stated objective, not a regimen.
              </p>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-base font-semibold">Iterations: surrogate prediction vs. actual fitness</h3>
            <p className="prose-muted mb-2 text-xs">
              <code className="font-mono">predicted_mean</code>/<code className="font-mono">predicted_std</code> are the
              surrogate's belief <strong>before</strong> the real evaluation (empty during the random initial design, which
              has no surrogate yet). Comparing them to <code className="font-mono">real_fitness</code> shows how
              well-calibrated the surrogate was.
            </p>
            <IterationTable records={records} />
          </div>

          <div>
            <h3 className="mb-2 text-base font-semibold">Export</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => downloadJson(`${result.run_id ?? 'active_learning'}.json`, result)}
              >
                ⬇ Active learning result (JSON)
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  downloadText(
                    `${result.run_id ?? 'active_learning'}.csv`,
                    rowsCsv(
                      records.map((r) => ({
                        iteration: r.iteration,
                        phase: r.phase,
                        real_fitness: r.real_fitness,
                        predicted_mean: r.predicted_mean,
                        predicted_std: r.predicted_std,
                        acquisition_value: r.acquisition_value,
                        best_so_far: r.best_so_far,
                        n_real_evaluations: r.n_real_evaluations,
                        ...Object.fromEntries(Object.entries(r.genome).map(([k, v]) => [`gene_${k}`, v])),
                      })),
                    ),
                    'text/csv',
                  )
                }
              >
                ⬇ Iterations table (CSV)
              </button>
            </div>
            <p className="prose-muted mt-2 text-xs">
              This shows one optimizer <em>technique</em> (surrogate-guided selective evaluation) under a fixed
              real-evaluation budget — it is not a claim about biology.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
