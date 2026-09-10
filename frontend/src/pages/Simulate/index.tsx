// Port of app/pages/01_Simulate.py (SDD §16, page 1).
import { useCallback, useMemo, useState } from 'react'

import { ApiError } from '../../api/client'
import { simulate as apiSimulate } from '../../api/endpoints'
import type { ChipParams, ModelConfig, SimulationRun } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { Callout } from '../../components/Callout'
import { ChipMapper } from '../../components/ChipMapper'
import { MetricRow } from '../../components/MetricRow'
import { ModelConfigForm } from '../../components/ModelConfigForm'
import { PageHeader } from '../../components/PageHeader'
import { PopulationCanvas } from '../../components/PopulationCanvas'
import { ProtocolTable } from '../../components/ProtocolTable'
import { ScheduleEditor } from '../../components/ScheduleEditor'
import { clearBaseline, loadBaseline, saveBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { appliedScheduleChart } from '../../components/charts/scheduleCharts'
import {
  fitnessBreakdownBar,
  lengthDistribution,
  lengthTrajectory,
  populationCurve,
  senescenceCurve,
} from '../../components/charts/simulationCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, timeseriesCsv } from '../../components/download'
import { configPayload, isScheduled, scheduledParameters, withSchedule } from '../../components/scheduleUtils'
import { FEATURES } from '../../features'
import { reproduceCommand, terminalMetrics } from './metrics'

const FEATURE = FEATURES.find((f) => f.path === '/simulate')!
const CHIP_KEYS: ReadonlySet<keyof ModelConfig> = new Set(['stress_level', 'repair_rate', 'cycles'] as const)
// The chip mapper derives these two; they cannot be scheduled at the same time.
const CHIP_UNAVAILABLE: ReadonlyMap<string, string> = new Map([
  ['stress_level', 'derived from chip'],
  ['repair_rate', 'derived from chip'],
])

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
      const res = await apiSimulate({ config: configPayload(effective) })
      setRun(res.run)
      setCursor(null)
    } catch (err: unknown) {
      if (err instanceof ApiError) setError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setRunning(false)
    }
  }

  function onReset() {
    if (!bounds) return
    setEdited(bounds.demo)
    clearBaseline()
    setUseChip(false)
    setDerived(null)
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
    setNotice(`Loaded the "${name}" protocol (configs/${name}.yaml) -- a model scenario, not a regimen.`)
  }

  const applied = run && run.valid ? run.applied_schedule ?? {} : {}
  const hasProtocol = Object.keys(applied).length > 0

  const figures = useMemo(() => {
    if (!run || !run.valid) return null
    return {
      protocol: Object.keys(run.applied_schedule ?? {}).length ? appliedScheduleChart(run.applied_schedule, dark, cursor) : null,
      length: lengthTrajectory(run, dark, cursor),
      dist: lengthDistribution(run, dark),
      sen: senescenceCurve(run, dark, cursor),
      pop: populationCurve(run, dark, cursor),
    }
  }, [run, dark, cursor])
  const breakdownFig = useMemo(
    () => (run && run.valid && bounds ? fitnessBreakdownBar(run.fitness, bounds.fitness_weights_default, dark) : null),
    [run, bounds, dark],
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
                  <ScheduleEditor
                    bounds={bounds}
                    value={effective ?? config}
                    onChange={setEdited}
                    unavailable={useChip ? CHIP_UNAVAILABLE : undefined}
                    onLoadPreset={onLoadPreset}
                    disabled={running}
                    idPrefix="sim-sched"
                  />
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

              <div className="grid gap-4 xl:grid-cols-2">
                <Plot figure={figures.length} />
                <Plot figure={figures.dist} />
                <Plot figure={figures.sen} />
                <Plot figure={figures.pop} />
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
        </section>
      </div>
    </div>
  )
}
