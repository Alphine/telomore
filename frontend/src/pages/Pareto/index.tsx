// Port of app/pages/05_Pareto.py on top of the job-polling contract
// (POST /api/pareto -> GET /api/jobs/{id}, POST .../stop).
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { startPareto } from '../../api/endpoints'
import type { MOGenerationRecord, ModelConfig, MultiObjectiveConfig, ParetoResult } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { useJob } from '../../api/useJob'
import { BaselineSummary } from '../../components/BaselineSummary'
import { Callout } from '../../components/Callout'
import { CheckboxGroup } from '../../components/CheckboxGroup'
import { MetricRow } from '../../components/MetricRow'
import { NumberInput } from '../../components/NumberInput'
import { PageHeader } from '../../components/PageHeader'
import { ProgressBar } from '../../components/ProgressBar'
import { Provenance } from '../../components/Provenance'
import { loadBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { hypervolumeChart, paretoScatter, sortedFront } from '../../components/charts/paretoCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, rowsCsv } from '../../components/download'
import { genomeToConfig, parseIntList, saveCompareUserConfig } from '../../components/handoff'
import { FEATURES } from '../../features'
import { PARETO_DEFAULTS, WHY_NSGA2, defaultColorGene, frontColumns, frontRow } from './form'
import type { ParetoForm } from './form'

const FEATURE = FEATURES.find((f) => f.path === '/pareto')!

export function Pareto() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  const [form, setForm] = useState<ParetoForm>(PARETO_DEFAULTS)
  const [base, setBase] = useState<ModelConfig | null>(null)
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<MultiObjectiveConfig | null>(null)
  const [live, setLive] = useState<MOGenerationRecord[]>([])
  const [colorBy, setColorBy] = useState<string | null | undefined>(undefined)
  const [pick, setPick] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const { job, error: jobError, isActive, stop } = useJob<MOGenerationRecord, ParetoResult>(jobId)

  const baseline = base ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)
  const objInfo = useMemo(() => bounds?.objectives ?? {}, [bounds])

  // Accumulate per-generation progress into a live history (polling may skip
  // generations; result.history is authoritative once the job finishes).
  const progress = job?.progress ?? null
  if (progress && !live.some((r) => r.generation === progress.generation)) {
    setLive([...live, progress])
  }

  const result = job && (job.status === 'completed' || job.status === 'stopped') ? job.result : null
  const history = result?.history ?? live
  const objectives = submitted?.objectives ?? form.objectives
  const freeGenes = submitted?.free_genes ?? form.free_genes

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!bounds || !baseline) return
    setFormError(null)
    setNotice(null)
    const seeds = parseIntList(form.eval_seeds_text)
    if (seeds === null) {
      setFormError('Seeds must be integers.')
      return
    }
    if (form.objectives.length < 2) {
      setFormError('Select at least two objectives.')
      return
    }
    if (form.free_genes.length === 0) {
      setFormError('Select at least one gene the optimizer may change.')
      return
    }
    if (form.population_size % 2) {
      setFormError('Population must be even.')
      return
    }
    const { eval_seeds_text: _t, ...rest } = form
    const multiobjective: MultiObjectiveConfig = {
      ...rest,
      eval_seeds: seeds.length ? seeds : [42],
      checkpoint_every: 5,
      weights: bounds.fitness_weights_default,
    }
    setSubmitting(true)
    try {
      const { job_id } = await startPareto({ model: baseline, multiobjective, notes })
      setLive([])
      setColorBy(undefined)
      setPick(0)
      setSubmitted(multiobjective)
      setJobId(job_id)
    } catch (err: unknown) {
      if (err instanceof ApiError) setFormError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setFormError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setSubmitting(false)
    }
  }

  const front = useMemo(() => (result ? sortedFront(result.front, objectives, objInfo) : []), [result, objectives, objInfo])
  const colorOptions = useMemo(() => [...freeGenes, ...objectives.slice(2)], [freeGenes, objectives])
  const effectiveColor = colorBy === undefined ? defaultColorGene(front, freeGenes) : colorBy

  const hvFigure = useMemo(
    () => (history.length && objectives.length === 2 ? hypervolumeChart(history, dark) : null),
    [history, objectives, dark],
  )
  const scatter = useMemo(
    () => (result ? paretoScatter(result.front, objectives, objInfo, result.baseline, effectiveColor, dark) : null),
    [result, objectives, objInfo, effectiveColor, dark],
  )

  function sendToCompare() {
    if (!baseline || !front.length) return
    const c = front[Math.min(pick, front.length - 1)]
    saveCompareUserConfig({
      config: genomeToConfig(baseline, c.genome, baseline.seed),
      label: `Pareto front point #${pick}${result?.run_id ? ` of ${result.run_id}` : ''}`,
      run_id: result?.run_id ?? null,
    })
    setNotice('Sent. Open Compare → the "From Pareto page" scenario is pre-selected.')
  }

  const columns = frontColumns(front, objectives)
  const picked = front.length ? front[Math.min(pick, front.length - 1)] : null

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />
      <p className="text-sm leading-relaxed">
        <strong>Why a second optimizer?</strong> {WHY_NSGA2}
      </p>

      {boundsError && (
        <Callout tone="error" role="alert">
          Could not load parameter bounds: {boundsError}
        </Callout>
      )}
      {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}

      {bounds && baseline && (
        <form onSubmit={onSubmit} className="space-y-6">
          <BaselineSummary bounds={bounds} value={baseline} onChange={setBase} disabled={isActive} idPrefix="par-base" />

          <section className="card space-y-4 p-5">
            <h2 className="text-lg font-semibold">Objectives</h2>
            <CheckboxGroup
              legend="Optimise simultaneously (first two are plotted)"
              options={Object.keys(objInfo)}
              value={form.objectives}
              disabled={isActive}
              onChange={(objectives) => setForm({ ...form, objectives })}
              render={(o) => (
                <span>
                  <code className="font-mono text-xs">{o}</code> ({objInfo[o].direction}) —{' '}
                  <span className="prose-muted">{objInfo[o].description}</span>
                </span>
              )}
            />
          </section>

          <section className="card space-y-4 p-5">
            <h2 className="text-lg font-semibold">Optimizer</h2>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="par-pop">
                  Population (even)
                </label>
                <NumberInput
                  id="par-pop"
                  className="input !py-1.5 font-mono !text-sm"
                  value={form.population_size}
                  min={8}
                  max={200}
                  step={2}
                  disabled={isActive}
                  onChange={(v) => setForm({ ...form, population_size: Math.round(v) })}
                />
              </div>
              <div>
                <label className="label" htmlFor="par-gens">
                  Generations
                </label>
                <NumberInput
                  id="par-gens"
                  className="input !py-1.5 font-mono !text-sm"
                  value={form.generations}
                  min={1}
                  max={200}
                  step={1}
                  disabled={isActive}
                  onChange={(v) => setForm({ ...form, generations: Math.round(v) })}
                />
              </div>
              <div>
                <label className="label" htmlFor="par-seed">
                  Optimizer seed
                </label>
                <NumberInput
                  id="par-seed"
                  className="input !py-1.5 font-mono !text-sm"
                  value={form.seed}
                  min={0}
                  max={2 ** 31 - 1}
                  step={1}
                  disabled={isActive}
                  onChange={(v) => setForm({ ...form, seed: Math.round(v) })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ['mutation_rate', 'Mutation rate', 0, 1, 0.05],
                  ['mutation_sigma', 'Mutation sigma', 0.01, 0.5, 0.01],
                  ['crossover_rate', 'Crossover rate', 0, 1, 0.05],
                ] as Array<['mutation_rate' | 'mutation_sigma' | 'crossover_rate', string, number, number, number]>
              ).map(([key, label, min, max, step]) => (
                <div key={key}>
                  <label className="label flex items-baseline justify-between" htmlFor={`par-${key}`}>
                    <span>{label}</span>
                    <span className="font-mono text-xs">{form[key].toFixed(2)}</span>
                  </label>
                  <input
                    id={`par-${key}`}
                    type="range"
                    className="w-full accent-teal-600"
                    min={min}
                    max={max}
                    step={step}
                    value={form[key]}
                    disabled={isActive}
                    onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                  />
                </div>
              ))}
            </div>
            <CheckboxGroup
              legend="Genes the optimizer may change"
              help="Everything not selected stays fixed at the baseline value."
              options={bounds.evolvable}
              value={form.free_genes}
              disabled={isActive}
              onChange={(free_genes) => setForm({ ...form, free_genes })}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="par-seeds">
                  Simulator seeds per candidate (comma-separated)
                </label>
                <input
                  id="par-seeds"
                  className="input font-mono !text-sm"
                  value={form.eval_seeds_text}
                  disabled={isActive}
                  onChange={(e) => setForm({ ...form, eval_seeds_text: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="par-notes">
                  Notes for the ledger
                </label>
                <input id="par-notes" className="input" value={notes} disabled={isActive} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
          </section>

          {formError && (
            <Callout tone="error" role="alert">
              {formError}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={submitting || isActive}>
              {submitting ? 'Starting…' : '🎯 Run NSGA-II'}
            </button>
            {isActive && (
              <>
                <button type="button" className="btn-ghost" onClick={() => void stop()}>
                  ⏹ Stop
                </button>
                <span className="prose-muted text-xs">Stopping happens after the current generation finishes.</span>
              </>
            )}
          </div>
        </form>
      )}

      {/* ---------------------------------------------------- live progress */}
      {jobId && isActive && (
        <section className="card space-y-3 p-5" role="status" aria-live="polite">
          {(() => {
            const rec = job?.progress ?? null
            const n = submitted?.generations ?? 0
            return (
              <>
                <ProgressBar
                  fraction={rec && n > 0 ? rec.generation / n : 0}
                  text={
                    rec
                      ? `Generation ${rec.generation}/${n} · front ${rec.front_size} · HV ${rec.hypervolume.toFixed(3)} · ${rec.evaluations_so_far} simulations`
                      : job?.status === 'running'
                        ? 'Initialising population…'
                        : 'Queued…'
                  }
                />
                {rec && (
                  <p className="prose-muted text-xs">
                    best per objective:{' '}
                    {Object.entries(rec.objective_best)
                      .map(([k, v]) => `${k}=${v === null ? 'n/a' : v.toFixed(3)}`)
                      .join(', ')}
                  </p>
                )}
                {hvFigure && <Plot figure={hvFigure} />}
              </>
            )
          })()}
          {jobError && (
            <Callout tone="warning" role="alert">
              Polling problem: {jobError}
            </Callout>
          )}
        </section>
      )}

      {job?.status === 'failed' && (
        <Callout tone="error" role="alert">
          The optimization job failed: {job.error ?? 'unknown error'}
        </Callout>
      )}

      {notice && (
        <Callout tone="success" role="status">
          {notice}{' '}
          <Link className="link" to="/compare">
            Open Compare →
          </Link>
        </Callout>
      )}

      {!jobId && bounds && (
        <Callout tone="info">
          Choose objectives and press <strong>Run NSGA-II</strong>. 40 × 25 takes roughly two minutes on a laptop CPU.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {result && (
        <section className="space-y-6" aria-label="Pareto results">
          <MetricRow
            metrics={[
              { label: 'Pareto-optimal candidates', value: String(front.length) },
              {
                label: '2-D hypervolume',
                value:
                  objectives.length === 2 && result.history.length
                    ? result.history[result.history.length - 1].hypervolume.toFixed(3)
                    : 'n/a (>2 obj.)',
              },
              { label: 'Generations', value: String(Math.max(0, result.history.length - 1)) },
              { label: 'Simulations run', value: String(result.evaluations) },
              { label: 'Runtime', value: `${result.runtime_seconds.toFixed(0)} s` },
            ]}
          />
          {result.stopped_early && <Callout tone="warning">Stopped early at the user's request.</Callout>}
          {result.run_id && <Provenance runId={result.run_id} />}

          <div>
            <label className="label" htmlFor="par-color">
              Colour front by
            </label>
            <select
              id="par-color"
              className="input !w-auto !py-1.5 !text-sm"
              value={effectiveColor ?? 'none'}
              onChange={(e) => setColorBy(e.target.value === 'none' ? null : e.target.value)}
            >
              <option value="none">none</option>
              {colorOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          {scatter && <Plot figure={scatter} />}
          {hvFigure && <Plot figure={hvFigure} />}
          <p className="prose-muted text-xs">
            The dominated-candidate cloud of the Streamlit chart is not shown: the API's pareto result contains the
            front, the baseline and the history, not the final population.
          </p>

          <div>
            <h3 className="mb-2 text-base font-semibold">Pareto front</h3>
            <div className="card max-h-80 overflow-auto">
              <table className="w-full text-sm" data-testid="front-table">
                <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    {columns.map((c) => (
                      <th key={c} className="px-3 py-2 text-right">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {front.map((c, i) => {
                    const row = frontRow(c)
                    return (
                      <tr key={i} className={`border-t border-slate-200 dark:border-slate-800 ${i === pick ? 'bg-teal-50 dark:bg-teal-500/10' : ''}`}>
                        <td className="px-3 py-1.5">{i}</td>
                        {columns.map((col) => (
                          <td key={col} className="px-3 py-1.5 text-right">
                            {row[col] === null || row[col] === undefined ? '∞' : (row[col] as number).toFixed(3)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {picked && baseline && (
            <div className="card space-y-3 p-5">
              <h3 className="text-base font-semibold">Pick a point to compare</h3>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="label" htmlFor="par-pick">
                    Row of the front table (0 = first)
                  </label>
                  <NumberInput
                    id="par-pick"
                    className="input !w-28 !py-1.5 font-mono !text-sm"
                    value={pick}
                    min={0}
                    max={Math.max(front.length - 1, 0)}
                    step={1}
                    onChange={(v) => setPick(Math.round(v))}
                  />
                </div>
                <button type="button" className="btn-ghost" onClick={sendToCompare}>
                  Send this point to the Compare page as 'From Pareto page'
                </button>
              </div>
              <p className="prose-muted font-mono text-xs">
                {[
                  ...Object.entries(picked.genome).map(([k, v]) => `${k}=${v.toFixed(3)}`),
                  ...objectives.map((o) => `${o}=${picked.objectives[o].toFixed(3)}`),
                ].join(' · ')}
              </p>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-base font-semibold">Export</h3>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => downloadJson(`${result.run_id ?? 'pareto'}.json`, result)}>
                ⬇ Pareto result (JSON)
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => downloadText(`${result.run_id ?? 'pareto'}_front.csv`, rowsCsv(front.map(frontRow)), 'text/csv')}
              >
                ⬇ Front (CSV)
              </button>
            </div>
            <p className="prose-muted mt-2 text-xs">
              Every point is a model output. The front shows which trade-offs the <em>model</em> permits under the stated
              assumptions, not which one is biologically right. Scalar fitness uses the default objective weights.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
