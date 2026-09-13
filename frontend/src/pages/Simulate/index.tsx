// Port of app/pages/01_Simulate.py (SDD §16, page 1).
import { useCallback, useMemo, useState } from 'react'

import { ApiError } from '../../api/client'
import { simulate as apiSimulate, simulateEnsemble } from '../../api/endpoints'
import type { ChipParams, EnsembleResponse, ModelConfig, SimulationRun } from '../../api/types'
import { MAX_ENSEMBLE_SEEDS, MIN_ENSEMBLE_SEEDS } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { BiologicalAgeGauge } from '../../components/BiologicalAgeGauge'
import { Callout } from '../../components/Callout'
import { ChipMapper } from '../../components/ChipMapper'
import { EnsemblePopulationCanvas } from '../../components/EnsemblePopulationCanvas'
import { EnsembleSummaryTable } from '../../components/EnsembleSummaryTable'
import { MetricRow } from '../../components/MetricRow'
import { ModelConfigForm } from '../../components/ModelConfigForm'
import { PageHeader } from '../../components/PageHeader'
import { PopulationCanvas } from '../../components/PopulationCanvas'
import { ProtocolProposer } from '../../components/ProtocolProposer'
import { ProtocolTable } from '../../components/ProtocolTable'
import { ScheduleEditor } from '../../components/ScheduleEditor'
import { SubcloneEditor } from '../../components/SubcloneEditor'
import { clearBaseline, loadBaseline, saveBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { biologicalAgeChart } from '../../components/charts/biologicalAgeCharts'
import { ensembleFanChart } from '../../components/charts/ensembleCharts'
import { appliedScheduleChart } from '../../components/charts/scheduleCharts'
import {
  fitnessBreakdownBar,
  lengthDistribution,
  lengthTrajectory,
  populationCurve,
  senescenceCurve,
} from '../../components/charts/simulationCharts'
import { mutationBurdenChart } from '../../components/charts/genomeStabilityCharts'
import { cloneFractionChart } from '../../components/charts/subcloneCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, timeseriesCsv } from '../../components/download'
import { configPayload, isScheduled, scheduledParameters, withSchedule } from '../../components/scheduleUtils'
import { finalComposition, hasSubclones } from '../../components/subclonesUtils'
import { FEATURES } from '../../features'
import { reproduceCommand, terminalMetrics } from './metrics'

const DEFAULT_N_SEEDS = 10

const FEATURE = FEATURES.find((f) => f.path === '/simulate')!
const CHIP_KEYS: ReadonlySet<keyof ModelConfig> = new Set(['stress_level', 'repair_rate', 'cycles'] as const)
// The chip mapper derives these two; they cannot be scheduled at the same time.
const CHIP_UNAVAILABLE: ReadonlyMap<string, string> = new Map([
  ['stress_level', 'derived from chip'],
  ['repair_rate', 'derived from chip'],
])

/** True when a run's genome-stability fields are actually in use (docs/MODEL.md §2.3) --
 * the feature is otherwise fully invisible in the results. */
function hasGenomeStability(config: ModelConfig): boolean {
  return config.replication_error_rate > 0 || config.oxidative_mutation_sensitivity > 0 || config.checkpoint_strength > 0
}

/** Drop the chip-derived parameters from a schedule (when the mapper is switched on). */
function withoutChipKeys(cfg: ModelConfig): ModelConfig {
  if (!isScheduled(cfg)) return cfg
  const values = Object.fromEntries(Object.entries(cfg.schedule.values).filter(([k]) => !CHIP_UNAVAILABLE.has(k)))
  return withSchedule(cfg, Object.keys(values).length ? { phases: cfg.schedule.phases, values } : null)
}

export function Simulate() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  const [edited, setEdited] = useState<ModelConfig | null>(null)
  const [useChip, setUseChip] = useState(false)
  const [derived, setDerived] = useState<ChipParams | null>(null)
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<SimulationRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  // Set only when the currently-loaded config came from an LLM proposal
  // (docs/ROADMAP.md LLM Layer 2); cleared by any other load/reset/edit so a
  // manually-tweaked-after-loading config isn't mis-tagged in the ledger.
  const [provenance, setProvenance] = useState<string | null>(null)

  // Ensemble / uncertainty visualization (ROADMAP.md candidate feature #2):
  // a separate, additive mode alongside the single-run flow above -- enabling
  // it never changes what "Run simulation" does.
  const [ensembleEnabled, setEnsembleEnabled] = useState(false)
  const [nSeeds, setNSeeds] = useState(DEFAULT_N_SEEDS)
  const [ensembleRunning, setEnsembleRunning] = useState(false)
  const [ensemble, setEnsemble] = useState<EnsembleResponse | null>(null)
  const [ensembleError, setEnsembleError] = useState<string | null>(null)

  // Defaults: the session baseline ("Set as baseline") or configs/demo.yaml,
  // exactly like baseline_config() -> demo_config() in the Streamlit app.
  const config: ModelConfig | null = edited ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)
  const effective = useMemo<ModelConfig | null>(() => {
    if (!config) return null
    return useChip && derived ? { ...config, ...derived } : config
  }, [config, useChip, derived])

  const onCycle = useCallback((c: number) => setCursor(c), [])

  // Scheduled parameters are read-only in the scalar form (the protocol below
  // sets them per phase; the scalar is the phase-0 value), like chip-derived ones.
  const scheduledKeys = effective ? scheduledParameters(effective) : []
  const locked: ReadonlySet<keyof ModelConfig> = new Set<keyof ModelConfig>([
    ...(useChip ? CHIP_KEYS : []),
    ...(scheduledKeys as Array<keyof ModelConfig>),
  ])
  const lockedLabels = Object.fromEntries(scheduledKeys.map((k) => [k, 'scheduled'])) as Partial<Record<keyof ModelConfig, string>>

  async function onRun() {
    if (!effective) return
    setRunning(true)
    setError(null)
    setNotice(null)
    try {
      // `schedule` is omitted from the request when nothing is scheduled.
      const res = await apiSimulate({ config: configPayload(effective), provenance: provenance ?? undefined })
      setRun(res.run)
      setCursor(null)
    } catch (err: unknown) {
      if (err instanceof ApiError) setError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setRunning(false)
    }
  }

  async function onRunEnsemble() {
    if (!effective) return
    setEnsembleRunning(true)
    setEnsembleError(null)
    setNotice(null)
    try {
      const res = await simulateEnsemble({ config: configPayload(effective), n_seeds: nSeeds, base_seed: effective.seed })
      setEnsemble(res)
    } catch (err: unknown) {
      if (err instanceof ApiError) setEnsembleError(`${err.status === 400 ? 'Invalid request: ' : ''}${err.message}`)
      else setEnsembleError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setEnsembleRunning(false)
    }
  }

  function onReset() {
    if (!bounds) return
    setEdited(bounds.demo)
    clearBaseline()
    setUseChip(false)
    setDerived(null)
    setProvenance(null)
    setNotice('Reset to the demo baseline (configs/demo.yaml).')
  }

  function onSetBaseline() {
    if (!effective) return
    saveBaseline(configPayload(effective))
    setNotice('Baseline updated for Evolve.')
  }

  function onLoadPreset(name: string, cfg: ModelConfig) {
    setEdited(cfg)
    setUseChip(false)
    setDerived(null)
    setProvenance(null)
    setNotice(`Loaded the "${name}" protocol (configs/${name}.yaml) -- a model scenario, not a regimen.`)
  }

  // LLM Layer 2 (docs/ROADMAP.md): loads a proposed config exactly like a
  // named preset above -- nothing runs until "Run simulation" is pressed.
  // Tagged in the ledger (provenance) so an LLM-proposed run stays
  // distinguishable from a human-typed or GA-evolved one.
  function onLoadProposal(cfg: ModelConfig, rationale: string) {
    setEdited(cfg)
    setUseChip(false)
    setDerived(null)
    setProvenance('LLM-proposed protocol (Layer 2 agent); may have been edited before running.')
    setNotice(`LLM proposal loaded -- a model scenario, not a regimen: ${rationale}`)
  }

  const applied = run && run.valid ? run.applied_schedule ?? {} : {}
  const hasProtocol = Object.keys(applied).length > 0

  const figures = useMemo(() => {
    if (!run || !run.valid) return null
    return {
      protocol: Object.keys(run.applied_schedule ?? {}).length ? appliedScheduleChart(run.applied_schedule, dark, cursor) : null,
      clones: Object.keys(run.clone_fraction ?? {}).length ? cloneFractionChart(run.clone_fraction, dark, cursor) : null,
      genomeStability: hasGenomeStability(run.config) ? mutationBurdenChart(run.timeseries, dark, cursor) : null,
      length: lengthTrajectory(run, dark, cursor),
      dist: lengthDistribution(run, dark),
      sen: senescenceCurve(run, dark, cursor),
      pop: populationCurve(run, dark, cursor),
      age: biologicalAgeChart(run, dark, cursor),
    }
  }, [run, dark, cursor])
  const breakdownFig = useMemo(
    () => (run && run.valid && bounds ? fitnessBreakdownBar(run.fitness, bounds.fitness_weights_default, dark) : null),
    [run, bounds, dark],
  )

  const ensembleFanFig = useMemo(
    () => (ensemble ? ensembleFanChart(ensemble.bands, dark, ensemble.config.senescence_threshold) : null),
    [ensemble, dark],
  )

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />

      <div className="gap-8 lg:grid lg:grid-cols-[21rem_minmax(0,1fr)]">
        {/* ------------------------------------------------ parameter form */}
        <aside className="card mb-6 self-start p-5 lg:mb-0">
          <h2 className="mb-4 text-lg font-semibold">Model parameters</h2>
          {boundsError && (
            <Callout tone="error" role="alert">
              Could not load parameter bounds: {boundsError}
            </Callout>
          )}
          {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}
          {bounds && config && (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault()
                void onRun()
              }}
            >
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-teal-600"
                  checked={useChip}
                  disabled={running}
                  onChange={(e) => {
                    setUseChip(e.target.checked)
                    if (!e.target.checked) setDerived(null)
                    else setEdited(withoutChipKeys(effective ?? config))
                  }}
                />
                <span>Derive stress/repair from organ-on-chip conditions</span>
              </label>
              {useChip && <ChipMapper onDerived={setDerived} disabled={running} />}

              <ModelConfigForm
                bounds={bounds}
                value={effective ?? config}
                onChange={setEdited}
                locked={locked.size ? locked : undefined}
                lockedLabels={lockedLabels}
                afterDynamics={
                  <>
                    <ScheduleEditor
                      bounds={bounds}
                      value={effective ?? config}
                      onChange={setEdited}
                      unavailable={useChip ? CHIP_UNAVAILABLE : undefined}
                      onLoadPreset={onLoadPreset}
                      disabled={running}
                      idPrefix="sim-sched"
                    />
                    <ProtocolProposer baseConfig={effective ?? config} onLoad={onLoadProposal} disabled={running} />
                    <SubcloneEditor
                      bounds={bounds}
                      value={effective ?? config}
                      onChange={setEdited}
                      disabled={running}
                      idPrefix="sim-clone"
                    />
                  </>
                }
                idPrefix="sim"
                disabled={running}
              />

              <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                <button type="submit" className="btn-primary w-full" disabled={running || (useChip && !derived)}>
                  {running ? 'Simulating…' : '▶ Run simulation'}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className="btn-ghost" onClick={onReset} disabled={running}>
                    Reset to demo baseline
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={onSetBaseline}
                    disabled={running}
                    title="Use these parameters as the baseline for Evolve."
                  >
                    Set as baseline
                  </button>
                </div>
                <p className="prose-muted text-xs">
                  Every run is recorded in the experiment registry by the API (the run id is shown with the
                  results), so there is no opt-in checkbox here.
                </p>
              </div>

              <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-teal-600"
                    checked={ensembleEnabled}
                    disabled={running || ensembleRunning}
                    onChange={(e) => setEnsembleEnabled(e.target.checked)}
                  />
                  <span>
                    Ensemble (uncertainty): run the same configuration under several simulator seeds and show the
                    spread across independent stochastic realizations, instead of one trajectory.
                  </span>
                </label>
                {ensembleEnabled && (
                  <>
                    <label className="flex items-center justify-between gap-2 text-sm" htmlFor="sim-n-seeds">
                      <span>Number of seeds</span>
                      <input
                        id="sim-n-seeds"
                        type="number"
                        className="input !w-24"
                        min={MIN_ENSEMBLE_SEEDS}
                        max={MAX_ENSEMBLE_SEEDS}
                        step={1}
                        value={nSeeds}
                        disabled={ensembleRunning}
                        onChange={(e) => setNSeeds(Math.trunc(Number(e.target.value)))}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-primary w-full"
                      disabled={ensembleRunning || (useChip && !derived) || nSeeds < MIN_ENSEMBLE_SEEDS || nSeeds > MAX_ENSEMBLE_SEEDS}
                      onClick={() => void onRunEnsemble()}
                    >
                      {ensembleRunning ? 'Running ensemble…' : `▶ Run ensemble (${nSeeds} seeds)`}
                    </button>
                    <p className="prose-muted text-xs">
                      Seeds {nSeeds >= 1 ? `${effective?.seed ?? 0}..${(effective?.seed ?? 0) + nSeeds - 1}` : ''} (base
                      seed = the config's own seed); {MIN_ENSEMBLE_SEEDS}-{MAX_ENSEMBLE_SEEDS} seeds per run.
                    </p>
                  </>
                )}
              </div>
            </form>
          )}
        </aside>

        {/* --------------------------------------------------------- results */}
        <section className="min-w-0 space-y-6">
          {notice && <Callout tone="success" role="status">{notice}</Callout>}
          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}

          {!run && !running && (
            <Callout tone="info">
              Set parameters in the panel and press <strong>Run simulation</strong>. The default baseline is the{' '}
              <em>stressed culture</em> scenario from <code className="font-mono text-xs">configs/demo.yaml</code>.
            </Callout>
          )}
          {running && (
            <div className="card flex items-center gap-3 p-5" role="status">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" aria-hidden />
              Simulating…
            </div>
          )}

          {run && !run.valid && (
            <Callout tone="error" role="alert">
              Simulation marked <strong>invalid</strong>: {run.failure_reason ?? 'unknown reason'}. Invalid runs never
              receive a fitness score (SDD §30).
            </Callout>
          )}

          {run && run.valid && figures && (
            <>
              <MetricRow metrics={terminalMetrics(run)} />
              <p className="prose-muted text-xs">
                Recorded as <code className="font-mono">{run.run_id}</code> · config hash{' '}
                <code className="font-mono">{run.config_hash}</code>
              </p>

              <BiologicalAgeGauge score={run.biological_age} />

              <PopulationCanvas run={run} onCycleChange={onCycle} dark={dark} />

              {hasProtocol && figures.protocol && isScheduled(run.config) && (
                <section className="space-y-3" aria-label="Applied protocol">
                  <Plot figure={figures.protocol} />
                  <ProtocolTable
                    schedule={run.config.schedule}
                    cycles={run.config.cycles}
                    applied={applied}
                    title="Protocol phases (time averages computed from the applied per-cycle values)"
                  />
                  <p className="prose-muted text-xs">
                    The step lines show the value in force at each cycle. The intervention-cost term uses the time
                    averages above (docs/MODEL.md §2.1); the protocol is a model scenario, not a regimen.
                  </p>
                </section>
              )}

              {figures.clones && hasSubclones(run.config) && (
                <section className="space-y-3" aria-label="Sub-clone composition">
                  <Plot figure={figures.clones} />
                  <div className="card overflow-x-auto p-3">
                    <p className="mb-2 text-xs font-semibold">Final composition</p>
                    <table className="w-full text-sm" data-testid="final-composition-table">
                      <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="px-2 py-1">clone</th>
                          <th className="px-2 py-1 text-right">final fraction</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {finalComposition(run.clone_fraction).map(({ name, fraction }) => (
                          <tr key={name} className="border-t border-slate-200 dark:border-slate-800">
                            <td className="px-2 py-1">{name}</td>
                            <td className="px-2 py-1 text-right">{(fraction * 100).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="prose-muted text-xs">
                    Share of the living population per clone. Clones are abstract parameter variants, not a real
                    genetic/mutation model (docs/SCIENTIFIC_SCOPE.md).
                  </p>
                </section>
              )}

              {figures.genomeStability && hasGenomeStability(run.config) && (
                <section className="space-y-3" aria-label="Genome stability">
                  <Plot figure={figures.genomeStability} />
                  <div className="card overflow-x-auto p-3">
                    <table className="w-full text-sm" data-testid="genome-stability-table">
                      <tbody className="font-mono">
                        <tr>
                          <td className="px-2 py-1">final mean mutation burden</td>
                          <td className="px-2 py-1 text-right">
                            {(run.terminal_metrics.final_mutation_burden ?? 0).toFixed(4)}
                          </td>
                        </tr>
                        <tr className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1">genomic instability index</td>
                          <td className="px-2 py-1 text-right">
                            {((run.terminal_metrics.genomic_instability_index ?? 0) * 100).toFixed(1)}%
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="prose-muted text-xs">
                    Genome instability is a per-cell mutation-burden abstraction, not a mechanistic
                    sequence/locus model (docs/SCIENTIFIC_SCOPE.md).
                  </p>
                </section>
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                <Plot figure={figures.length} />
                <Plot figure={figures.dist} />
                <Plot figure={figures.sen} />
                <Plot figure={figures.pop} />
                {figures.age && <Plot figure={figures.age} />}
              </div>

              <details className="card p-5">
                <summary className="cursor-pointer select-none text-sm font-semibold">
                  Fitness breakdown under default objective weights
                </summary>
                <div className="mt-3 space-y-2">
                  {breakdownFig && <Plot figure={breakdownFig} />}
                  <p className="prose-muted text-xs">
                    Fitness is the experimenter's objective, not a biological ground truth. The API scores each run
                    with the default weights; adjust the weights on the Evolve page.
                  </p>
                </div>
              </details>

              <div>
                <h3 className="mb-2 text-base font-semibold">Export</h3>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => downloadJson(`simulation_seed${run.seed}.json`, run)}
                  >
                    ⬇ Export JSON
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => downloadText(`simulation_seed${run.seed}.csv`, timeseriesCsv(run.timeseries), 'text/csv')}
                  >
                    ⬇ Export CSV
                  </button>
                </div>
              </div>

              <details className="card p-5">
                <summary className="cursor-pointer select-none text-sm font-semibold">
                  Provenance (reproducibility metadata)
                </summary>
                <pre className="mono-block mt-3 whitespace-pre-wrap">
                  {`model_version = ${run.model_version}
seed          = ${run.seed}
config_hash   = ${run.config_hash}
runtime       = ${(run.runtime_seconds * 1000).toFixed(1)} ms
reproduce     : ${reproduceCommand(run)}`}
                </pre>
                <pre className="mono-block mt-3 text-xs">{JSON.stringify(run.config, null, 2)}</pre>
              </details>
            </>
          )}

          {/* --------------------------------------------- ensemble results */}
          {ensembleEnabled && (
            <section className="space-y-4" aria-label="Ensemble results">
              <h2 className="text-lg font-semibold">Ensemble (uncertainty)</h2>
              {ensembleError && (
                <Callout tone="error" role="alert">
                  {ensembleError}
                </Callout>
              )}
              {!ensemble && !ensembleRunning && !ensembleError && (
                <Callout tone="info">
                  Set the number of seeds above and press <strong>Run ensemble</strong> to see the spread across
                  independent stochastic realizations of the same configuration.
                </Callout>
              )}
              {ensembleRunning && (
                <div className="card flex items-center gap-3 p-5" role="status">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" aria-hidden />
                  Running {nSeeds} seeds…
                </div>
              )}
              {ensemble && ensembleFanFig && (
                <>
                  <p className="prose-muted text-xs">
                    Recorded as <code className="font-mono">{ensemble.run_id}</code> · seeds{' '}
                    <code className="font-mono">
                      {ensemble.base_seed}..{ensemble.base_seed + ensemble.n_seeds - 1}
                    </code>{' '}
                    · config hash <code className="font-mono">{ensemble.config_hash}</code>
                  </p>
                  <p className="prose-muted text-xs">
                    Spread across {ensemble.n_seeds} independent stochastic realizations of the same configuration
                    (same parameters, different simulator seed) -- not biological population variability beyond the
                    model's own per-division noise term.
                  </p>
                  <Plot figure={ensembleFanFig} />
                  <EnsembleSummaryTable series={ensemble.series} />
                  <EnsemblePopulationCanvas series={ensemble.series} bands={ensemble.bands} initialLength={ensemble.config.initial_length} dark={dark} />
                </>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  )
}
