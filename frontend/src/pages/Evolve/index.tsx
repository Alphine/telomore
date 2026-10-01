// Port of app/pages/02_Evolve.py (SDD §16, page 2) on top of the
// job-polling contract (POST /api/evolve -> GET /api/jobs/{id}).
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { startEvolve } from '../../api/endpoints'
import type { EvolutionConfig, EvolveResult, FitnessWeights, GenerationRecord, ModelConfig } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { useJob } from '../../api/useJob'
import { Callout } from '../../components/Callout'
import { useActiveJobOfKind } from '../../jobs/useActiveJobs'
import { GeneName } from '../../components/GeneName'
import { InterpretPanel } from '../../components/InterpretPanel'
import { MetricRow } from '../../components/MetricRow'
import { ModelConfigForm } from '../../components/ModelConfigForm'
import { NumberInput } from '../../components/NumberInput'
import { DemoForm } from '../../components/DemoForm'
import { useDemoScenario } from '../../demo/context'
import { DEMO_JOB_PREFIX } from '../../demo/replay'
import type { EvolveRequest } from '../../api/types'
import { PageHeader } from '../../components/PageHeader'
import { PhasesControl } from '../../components/PhasesControl'
import { ProgressBar } from '../../components/ProgressBar'
import { ProtocolTable } from '../../components/ProtocolTable'
import { loadBaseline, saveBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { diversityChart, evolutionFitnessChart, parameterTrajectoryChart } from '../../components/charts/evolutionCharts'
import { appliedScheduleChart, scheduleToApplied } from '../../components/charts/scheduleCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, historyCsv } from '../../components/download'
import { genomeToConfig, saveEvolveBest } from '../../components/handoff'
import { groupGenes, isScheduled } from '../../components/scheduleUtils'
import { FEATURES } from '../../features'
import { FITNESS_FORMULA, WEIGHT_FIELDS, parseSeeds, signed, toForm } from './form'
import type { EvoForm } from './form'
import { usePersistentState } from '../../state/usePersistentState'

const FEATURE = FEATURES.find((f) => f.path === '/evolve')!

export function Evolve() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()
  const navigate = useNavigate()

  const [weights, setWeights] = usePersistentState<FitnessWeights | null>('evolve:weights', null)
  const [evo, setEvo] = usePersistentState<EvoForm | null>('evolve:evo', null)
  const [base, setBase] = usePersistentState<ModelConfig | null>('evolve:base', null)
  const [notes, setNotes] = usePersistentState('evolve:notes', '')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = usePersistentState<string | null>('evolve:jobId', null)
  const [nTotal, setNTotal] = usePersistentState('evolve:nTotal', 0)
  const [live, setLive] = usePersistentState<GenerationRecord[]>('evolve:live', [])
  const [notice, setNotice] = usePersistentState<string | null>('evolve:notice', null)

  // Re-adopt an in-flight job of our own kind: navigating away and back must
  // resume live progress, not reset to the idle form -- the job itself keeps
  // running server-side regardless of which page is open.
  const activeEvolveJob = useActiveJobOfKind('evolve')
  const effectiveJobId = jobId ?? activeEvolveJob?.job_id ?? null

  const { job, error: jobError, isActive, stop } = useJob<GenerationRecord, EvolveResult>(effectiveJobId)

  const w = weights ?? bounds?.fitness_weights_default ?? null
  const form = evo ?? (bounds ? toForm(bounds.evolution_default) : null)
  const baseline = base ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)

  // Accumulate the per-generation progress payloads into a live history
  // (polling at ~1 s may skip generations; the completed result.history is
  // authoritative and replaces this once the job finishes). Adjusted during
  // render (React's derived-state pattern) rather than in an effect.
  const progress = job?.progress ?? null
  if (progress && !live.some((r) => r.generation === progress.generation)) {
    setLive([...live, progress])
  }

  const result = job && (job.status === 'completed' || job.status === 'stopped') ? job.result : null
  const history = result?.history ?? live

  // Hand the best candidate to the Compare page ("Best evolved" scenario --
  // st.session_state["evo_result"] in Streamlit) as soon as a job finishes.
  // The genome is merged into the baseline the job was started from.
  useEffect(() => {
    if (!result || !baseline) return
    saveEvolveBest({
      config: genomeToConfig(baseline, result.best.genome),
      label: `Evolve run ${result.run_id ?? '(unrecorded)'} (fitness ${signed(result.best.fitness)})`,
      run_id: result.run_id,
    })
    // `baseline` is deliberately not a dependency: the saved scenario belongs
    // to the run, not to later edits of the baseline form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  // Demo mode: show the cached scenario (request fills the locked form, the job result is replayed locally).
  const demoSc = useDemoScenario<EvolveRequest, unknown>()
  useEffect(() => {
    const req = demoSc?.request
    if (!demoSc || !req || !bounds) return
    if (req.model) setBase({ ...bounds.demo, ...req.model })
    const evolution = { ...bounds.evolution_default, ...req.evolution }
    setEvo(toForm(evolution))
    setWeights(evolution.weights)
    setNotes(req.notes ?? '')
    setLive([])
    setNTotal(evolution.generations)
    setJobId(DEMO_JOB_PREFIX + demoSc.id)
  }, [demoSc, bounds, setBase, setEvo, setWeights, setNotes, setLive, setNTotal, setJobId])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form || !w || !baseline) return
    setFormError(null)
    setNotice(null)
    const seeds = parseSeeds(form.eval_seeds_text)
    if (seeds === null) {
      setFormError('Seeds must be integers.')
      return
    }
    if (form.free_genes.length === 0) {
      setFormError('Select at least one gene the optimizer may change.')
      return
    }
    const { eval_seeds_text: _t, ...rest } = form
    const evolution: EvolutionConfig = { ...rest, eval_seeds: seeds.length ? seeds : [1, 2, 3], weights: w }
    setSubmitting(true)
    try {
      const { job_id } = await startEvolve({ model: baseline, evolution, notes })
      setLive([])
      setNTotal(evolution.generations)
      setJobId(job_id)
    } catch (err: unknown) {
      if (err instanceof ApiError) setFormError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setFormError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setSubmitting(false)
    }
  }

  const figures = useMemo(() => {
    if (!bounds || history.length === 0) return null
    const genes = Object.keys(history[history.length - 1].best_genome)
    return {
      fitness: evolutionFitnessChart(history, dark),
      diversity: diversityChart(history, dark),
      params: parameterTrajectoryChart(history, genes, bounds.bounds, dark),
    }
  }, [history, bounds, dark])

  function setBestAsBaseline(res: EvolveResult) {
    if (!baseline) return
    const cfg: ModelConfig = genomeToConfig(baseline, res.best.genome)
    saveBaseline(cfg)
    setBase(cfg)
    setNotice('Best candidate saved as the baseline -- open Simulate to inspect its full trajectory.')
  }

  // The best candidate as a full config (GenomeSpec.to_config): with
  // schedule_phases > 1 its `<gene>@<phase>` genes form a schedule.
  const bestConfig = useMemo(() => (result && baseline ? genomeToConfig(baseline, result.best.genome) : null), [result, baseline])
  const bestProtocol = useMemo(
    () =>
      bestConfig && isScheduled(bestConfig)
        ? appliedScheduleChart(scheduleToApplied(bestConfig.schedule, bestConfig.cycles), dark, null, 'Best candidate protocol (per-cycle values)')
        : null,
    [bestConfig, dark],
  )

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />

      {boundsError && (
        <Callout tone="error" role="alert">
          Could not load parameter bounds: {boundsError}
        </Callout>
      )}
      {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}

      {bounds && form && w && baseline && (
        <DemoForm onSubmit={onSubmit} className="space-y-6">
          <p className="prose-muted">
            Baseline (fixed genes come from here): stress {baseline.stress_level.toFixed(2)} · maintenance{' '}
            {baseline.maintenance_rate.toFixed(2)} · repair {baseline.repair_rate.toFixed(2)} · shortening{' '}
            {baseline.shortening_rate.toFixed(0)} bp · threshold {(baseline.senescence_threshold / 1000).toFixed(1)} kb ·{' '}
            {baseline.cycles} cycles · seed {baseline.seed}. Change it on the{' '}
            <Link className="link" to="/simulate">
              Simulate
            </Link>{' '}
            page with <em>Set as baseline</em>, or edit it below.
          </p>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* ------------------------------------------------- objective */}
            <section className="card p-5">
              <h2 className="text-lg font-semibold">Objective (fitness weights)</h2>
              <p className="prose-muted mt-1 font-mono text-xs">{FITNESS_FORMULA}</p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {WEIGHT_FIELDS.map((f) => (
                  <div key={f.key}>
                    <label className="label flex items-baseline justify-between" htmlFor={`w-${f.key}`}>
                      <span>{f.label}</span>
                      <span className="font-mono text-xs">{w[f.key].toFixed(2)}</span>
                    </label>
                    <input
                      id={`w-${f.key}`}
                      type="range"
                      className="w-full accent-teal-600"
                      min={0}
                      max={1}
                      step={0.05}
                      value={w[f.key]}
                      disabled={isActive}
                      onChange={(e) => setWeights({ ...w, [f.key]: Number(e.target.value) })}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* ------------------------------------------------- optimizer */}
            <section className="card space-y-4 p-5">
              <h2 className="text-lg font-semibold">Optimizer</h2>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label" htmlFor="evo-pop">
                    Candidates per generation
                  </label>
                  <NumberInput
                    id="evo-pop"
                    className="input !py-1.5 font-mono !text-sm"
                    value={form.population_size}
                    min={8}
                    max={256}
                    step={8}
                    disabled={isActive}
                    onChange={(v) => setEvo({ ...form, population_size: Math.round(v) })}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="evo-gens">
                    Generations
                  </label>
                  <NumberInput
                    id="evo-gens"
                    className="input !py-1.5 font-mono !text-sm"
                    value={form.generations}
                    min={1}
                    max={200}
                    step={1}
                    disabled={isActive}
                    onChange={(v) => setEvo({ ...form, generations: Math.round(v) })}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="evo-seed">
                    Optimizer seed
                  </label>
                  <NumberInput
                    id="evo-seed"
                    className="input !py-1.5 font-mono !text-sm"
                    value={form.seed}
                    min={0}
                    max={2 ** 31 - 1}
                    step={1}
                    disabled={isActive}
                    onChange={(v) => setEvo({ ...form, seed: Math.round(v) })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['mutation_rate', 'Mutation rate', 0, 1, 0.05],
                    ['mutation_sigma', 'Mutation sigma (normalised)', 0.01, 0.5, 0.01],
                    ['elite_fraction', 'Elite fraction', 0, 0.5, 0.05],
                    ['crossover_rate', 'Crossover rate', 0, 1, 0.05],
                  ] as Array<[keyof EvoForm, string, number, number, number]>
                ).map(([key, label, min, max, step]) => (
                  <div key={key}>
                    <label className="label flex items-baseline justify-between" htmlFor={`evo-${key}`}>
                      <span>{label}</span>
                      <span className="font-mono text-xs">{(form[key] as number).toFixed(2)}</span>
                    </label>
                    <input
                      id={`evo-${key}`}
                      type="range"
                      className="w-full accent-teal-600"
                      min={min}
                      max={max}
                      step={step}
                      value={form[key] as number}
                      disabled={isActive}
                      onChange={(e) => setEvo({ ...form, [key]: Number(e.target.value) })}
                    />
                  </div>
                ))}
                <div>
                  <label className="label" htmlFor="evo-xkind">
                    Crossover
                  </label>
                  <select
                    id="evo-xkind"
                    className="input !py-1.5 !text-sm"
                    value={form.crossover_kind}
                    disabled={isActive}
                    onChange={(e) => setEvo({ ...form, crossover_kind: e.target.value as EvoForm['crossover_kind'] })}
                  >
                    <option value="uniform">uniform</option>
                    <option value="arithmetic">arithmetic</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="evo-patience">
                    Early-stop patience (0 = off)
                  </label>
                  <NumberInput
                    id="evo-patience"
                    className="input !py-1.5 font-mono !text-sm"
                    value={form.early_stopping_patience}
                    min={0}
                    max={100}
                    step={1}
                    disabled={isActive}
                    onChange={(v) => setEvo({ ...form, early_stopping_patience: Math.round(v) })}
                  />
                </div>
              </div>
              <fieldset>
                <legend className="label">Genes the optimizer may change</legend>
                <p className="prose-muted mb-2 text-xs">Everything not selected stays fixed at the baseline value.</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {bounds.evolvable.map((g) => (
                    <label key={g} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="accent-teal-600"
                        checked={form.free_genes.includes(g)}
                        disabled={isActive}
                        onChange={(e) =>
                          setEvo({
                            ...form,
                            free_genes: e.target.checked
                              ? bounds.evolvable.filter((x) => x === g || form.free_genes.includes(x))
                              : form.free_genes.filter((x) => x !== g),
                          })
                        }
                      />
                      <code className="font-mono text-xs">{g}</code>
                    </label>
                  ))}
                </div>
              </fieldset>
              <PhasesControl
                id="evo-phases"
                value={form.schedule_phases}
                max={bounds.max_phases}
                disabled={isActive}
                onChange={(schedule_phases) => setEvo({ ...form, schedule_phases })}
              />
              <div>
                <label className="label" htmlFor="evo-seeds">
                  Simulator seeds per candidate (comma-separated; more = less noise, slower)
                </label>
                <input
                  id="evo-seeds"
                  className="input font-mono !text-sm"
                  value={form.eval_seeds_text}
                  disabled={isActive}
                  onChange={(e) => setEvo({ ...form, eval_seeds_text: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="evo-notes">
                  Notes for the experiment ledger
                </label>
                <input
                  id="evo-notes"
                  className="input"
                  value={notes}
                  disabled={isActive}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </section>
          </div>

          <details className="card p-5">
            <summary className="cursor-pointer select-none text-sm font-semibold">
              Baseline model parameters (fixed genes are taken from here)
            </summary>
            <div className="mt-4 max-w-xl">
              <ModelConfigForm bounds={bounds} value={baseline} onChange={setBase} idPrefix="evo-base" disabled={isActive} />
            </div>
          </details>

          {formError && (
            <Callout tone="error" role="alert">
              {formError}
            </Callout>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={submitting || isActive}>
              {submitting ? 'Starting…' : '🧬 Evolve'}
            </button>
            {isActive && (
              <button type="button" className="btn-ghost" onClick={() => void stop()}>
                ⏹ Stop
              </button>
            )}
          </div>
        </DemoForm>
      )}

      {/* ---------------------------------------------------- live progress */}
      {effectiveJobId && isActive && (
        <section className="card space-y-3 p-5" role="status" aria-live="polite">
          {(() => {
            const rec = job?.progress ?? null
            const frac = rec && nTotal > 0 ? Math.min(rec.generation / nTotal, 1) : 0
            return (
              <>
                <ProgressBar
                  fraction={frac}
                  text={
                    rec
                      ? `Generation ${rec.generation}/${nTotal} · best ${signed(rec.best_fitness, 4)} · ${rec.evaluations_so_far} simulations · ${rec.elapsed_seconds.toFixed(0)}s`
                      : job?.status === 'running'
                        ? 'Initialising population…'
                        : 'Queued…'
                  }
                />
                {figures && <Plot figure={figures.fitness} />}
                {rec && (
                  <p className="prose-muted text-xs">
                    Best genome so far:{' '}
                    {Object.entries(rec.best_genome)
                      .map(([k, v]) => `${k}=${v.toFixed(3)}`)
                      .join(', ')}
                  </p>
                )}
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

      {notice && <Callout tone="success" role="status">{notice}</Callout>}

      {!effectiveJobId && bounds && (
        <Callout tone="info">
          Configure the objective and optimizer, then press <strong>Evolve</strong>. A 32 × 20 run takes on the order
          of a minute or two on a laptop CPU.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {result && figures && bounds && (
        <section className="space-y-6" aria-label="Evolution results">
          <MetricRow
            metrics={[
              { label: 'Baseline fitness', value: signed(result.baseline.fitness) },
              {
                label: 'Best fitness',
                value: signed(result.best.fitness),
                delta: signed(result.best.fitness - result.baseline.fitness),
              },
              { label: 'Generations', value: String(Math.max(0, result.history.length - 1)) },
              { label: 'Simulations run', value: String(result.evaluations) },
              { label: 'Runtime', value: `${result.runtime_seconds.toFixed(0)} s` },
            ]}
          />
          {result.stopped_early && <Callout tone="warning">Stopped early: {result.stop_reason}</Callout>}
          {result.run_id && (
            <Callout tone="success">
              Recorded as <strong>{result.run_id}</strong> in the experiment ledger.
            </Callout>
          )}
          {result.run_id && <InterpretPanel runId={result.run_id} />}

          <div className="grid gap-4 xl:grid-cols-2">
            <Plot figure={figures.fitness} />
            <Plot figure={figures.diversity} />
          </div>
          <Plot figure={figures.params} />

          <div>
            <h3 className="mb-2 text-base font-semibold">Best candidate vs baseline (free genes)</h3>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2">gene</th>
                    <th className="px-4 py-2 text-right">baseline</th>
                    <th className="px-4 py-2 text-right">evolved</th>
                    <th className="px-4 py-2 text-right">change</th>
                    <th className="px-4 py-2 text-right">change %</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {groupGenes(Object.keys(result.best.genome)).flatMap((grp) => grp.genes).map((g) => {
                    const b = result.baseline.genome[g]
                    const e = result.best.genome[g]
                    const pct = b ? ((e - b) / b) * 100 : NaN
                    return (
                      <tr key={g} className="border-t border-slate-200 dark:border-slate-800" data-gene={g}>
                        <td className="px-4 py-2">
                          <GeneName gene={g} />
                        </td>
                        <td className="px-4 py-2 text-right">{b?.toFixed(3)}</td>
                        <td className="px-4 py-2 text-right">{e.toFixed(3)}</td>
                        <td className="px-4 py-2 text-right">{signed(e - (b ?? 0))}</td>
                        <td className="px-4 py-2 text-right">{Number.isNaN(pct) ? 'n/a' : `${signed(pct, 1)}%`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {result.best.breakdown && (
              <p className="prose-muted mt-2 text-xs">
                Best candidate fitness breakdown: survival {result.best.breakdown.survival.toFixed(3)} · reserve{' '}
                {result.best.breakdown.reserve.toFixed(3)} · senescence {result.best.breakdown.senescence.toFixed(3)} ·
                instability {result.best.breakdown.instability.toFixed(3)} · cost {result.best.breakdown.cost.toFixed(3)}
              </p>
            )}
            <p className="prose-muted mt-1 text-xs">
              The final-population table from the Streamlit page is not shown: the API's evolve result does not include
              the final population (only best / baseline / history).
            </p>
          </div>

          {bestConfig && isScheduled(bestConfig) && bestProtocol && (
            <div className="space-y-3" aria-label="Best candidate protocol">
              <h3 className="text-base font-semibold">Best candidate protocol ({bestConfig.schedule.phases} phases)</h3>
              <Plot figure={bestProtocol} />
              <ProtocolTable schedule={bestConfig.schedule} cycles={bestConfig.cycles} />
              <p className="prose-muted text-xs">
                One value per phase for each scheduled gene; the cost term is charged on the time averages. This is the
                optimizer's best model configuration under the stated objective, not a dosing regimen
                (docs/SCIENTIFIC_SCOPE.md). Simulate it via <em>Set best as baseline</em>.
              </p>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-base font-semibold">Export &amp; hand-off</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => downloadJson(`${result.run_id ?? 'evolution'}.json`, result)}
              >
                ⬇ Evolution result (JSON)
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  downloadText(`${result.run_id ?? 'evolution'}_history.csv`, historyCsv(result.history), 'text/csv')
                }
              >
                ⬇ Generation history (CSV)
              </button>
              <button type="button" className="btn-ghost" onClick={() => setBestAsBaseline(result)}>
                Set best as baseline
              </button>
              <button type="button" className="btn-ghost" onClick={() => navigate('/compare')}>
                Send best to Compare →
              </button>
            </div>
            <p className="prose-muted mt-2 text-xs">
              Fitness ≠ biological truth. The optimizer optimised the objective above under the model's assumptions;
              see docs/SCIENTIFIC_SCOPE.md.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
