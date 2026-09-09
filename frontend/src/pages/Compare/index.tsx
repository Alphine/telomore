// Port of app/pages/03_Compare.py on top of POST /api/compare (synchronous).
// Scenario sources: the shared baseline (sessionStorage `tel_baseline_config`),
// the last Evolve result (`tel_evolve_best`), a Pareto point
// (`tel_compare_user_config`) and a manually edited ModelConfig.
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { compare as apiCompare } from '../../api/endpoints'
import type { CompareResponse, CompareScenario, ModelConfig } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { Callout } from '../../components/Callout'
import { ModelConfigForm } from '../../components/ModelConfigForm'
import { NumberInput } from '../../components/NumberInput'
import { PageHeader } from '../../components/PageHeader'
import { loadBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { overlayChart } from '../../components/charts/compareCharts'
import { fitnessBreakdownBar } from '../../components/charts/simulationCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { loadCompareUserConfig, loadEvolveBest, signed } from '../../components/handoff'
import { FEATURES } from '../../features'

const FEATURE = FEATURES.find((f) => f.path === '/compare')!

const PARAM_COLUMNS: Array<keyof ModelConfig> = [
  'stress_level',
  'maintenance_rate',
  'repair_rate',
  'shortening_rate',
  'initial_length',
  'senescence_threshold',
  'seed',
]

const DELTA_COLUMNS: Array<[string, keyof NonNullable<CompareResponse['scenarios'][number]['deltas']>, number]> = [
  ['Δ fitness', 'fitness_abs', 3],
  ['Δ fitness %', 'fitness_pct', 1],
  ['Δ senescence (pp)', 'senescence_pp', 2],
  ['Δ shortest-telomere reserve (kb)', 'reserve_kb', 3],
  ['Δ mean length (kb)', 'mean_length_kb', 3],
  ['Δ survival (AUC)', 'survival_abs', 3],
]

function summary(c: ModelConfig): string {
  return `stress=${c.stress_level.toFixed(3)}, maintenance=${c.maintenance_rate.toFixed(3)}, repair=${c.repair_rate.toFixed(3)}`
}

export function Compare() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  // Hand-offs are read once per mount (they only change on other pages).
  const [evolved] = useState(() => loadEvolveBest())
  const [pareto] = useState(() => loadCompareUserConfig())
  const [includeEvolved, setIncludeEvolved] = useState(evolved !== null)
  const [includePareto, setIncludePareto] = useState(pareto !== null)
  const [includeManual, setIncludeManual] = useState(false)
  const [manual, setManual] = useState<ModelConfig | null>(null)
  const [sameSeed, setSameSeed] = useState(true)
  const [seed, setSeed] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [response, setResponse] = useState<CompareResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const baseline = bounds ? (loadBaseline() ?? bounds.demo) : null
  const manualCfg = manual ?? baseline
  const commonSeed = seed ?? baseline?.seed ?? 42

  const scenarios = useMemo<CompareScenario[]>(() => {
    if (!baseline) return []
    const out: CompareScenario[] = [{ name: 'Baseline', config: baseline }]
    if (includeEvolved && evolved) out.push({ name: 'Best evolved', config: evolved.config })
    if (includePareto && pareto) out.push({ name: 'From Pareto page', config: pareto.config })
    if (includeManual && manualCfg) out.push({ name: 'Manual', config: manualCfg })
    return out
  }, [baseline, includeEvolved, evolved, includePareto, pareto, includeManual, manualCfg])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!scenarios.length) return
    setRunning(true)
    setError(null)
    try {
      const res = await apiCompare({ scenarios, seed: sameSeed ? commonSeed : undefined })
      setResponse(res)
    } catch (err: unknown) {
      if (err instanceof ApiError) setError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setRunning(false)
    }
  }

  const valid = useMemo(() => response?.scenarios.filter((s) => s.result.valid) ?? [], [response])
  const invalid = useMemo(() => response?.scenarios.filter((s) => !s.result.valid) ?? [], [response])

  const figures = useMemo(() => {
    if (!valid.length || !baseline) return null
    const runs = valid.map((s) => ({ name: s.name, run: s.result }))
    return {
      length: overlayChart(runs, 'mean_length_bp', 'Mean telomere length (kb)', 'kb', dark, {
        kb: true,
        hline: baseline.senescence_threshold / 1000,
        hlineLabel: 'senescence threshold',
      }),
      shortest: overlayChart(runs, 'mean_shortest_per_cell_bp', 'Mean shortest telomere per cell (kb)', 'kb', dark, { kb: true }),
      senescence: overlayChart(runs, 'senescent_fraction', 'Senescent fraction', 'fraction', dark),
      population: overlayChart(runs, 'population_size', 'Living cells', 'cells', dark),
      proliferative: overlayChart(runs, 'proliferative_count', 'Proliferative cells', 'cells', dark),
    }
  }, [valid, baseline, dark])

  const breakdowns = useMemo(
    () => (bounds ? valid.map((s) => fitnessBreakdownBar(s.breakdown, bounds.fitness_weights_default, dark, s.name)) : []),
    [valid, bounds, dark],
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

      {bounds && baseline && manualCfg && (
        <form onSubmit={onSubmit} className="space-y-6">
          <section className="card space-y-4 p-5">
            <h2 className="text-lg font-semibold">Scenarios</h2>
            <ul className="space-y-3 text-sm">
              <li className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-teal-600" checked readOnly disabled aria-label="Baseline (always included)" />
                <div>
                  <strong>Baseline</strong> — {summary(baseline)}, {baseline.cycles} cycles, seed {baseline.seed}.{' '}
                  <span className="prose-muted">
                    Change it on the{' '}
                    <Link className="link" to="/simulate">
                      Simulate
                    </Link>{' '}
                    page with <em>Set as baseline</em>.
                  </span>
                </div>
              </li>
              <li className="flex items-start gap-2">
                <input
                  id="cmp-evolved"
                  type="checkbox"
                  className="mt-0.5 accent-teal-600"
                  checked={includeEvolved && evolved !== null}
                  disabled={running || evolved === null}
                  onChange={(e) => setIncludeEvolved(e.target.checked)}
                />
                <label htmlFor="cmp-evolved">
                  <strong>Best evolved</strong>
                  {evolved ? (
                    <>
                      {' '}
                      — {summary(evolved.config)}. <span className="prose-muted">{evolved.label}</span>
                    </>
                  ) : (
                    <span className="prose-muted">
                      {' '}
                      — no Evolve result in this session yet. Run the{' '}
                      <Link className="link" to="/evolve">
                        Evolve
                      </Link>{' '}
                      page to add this scenario; you can still compare the baseline with a manual scenario.
                    </span>
                  )}
                </label>
              </li>
              <li className="flex items-start gap-2">
                <input
                  id="cmp-pareto"
                  type="checkbox"
                  className="mt-0.5 accent-teal-600"
                  checked={includePareto && pareto !== null}
                  disabled={running || pareto === null}
                  onChange={(e) => setIncludePareto(e.target.checked)}
                />
                <label htmlFor="cmp-pareto">
                  <strong>From Pareto page</strong>
                  {pareto ? (
                    <>
                      {' '}
                      — {summary(pareto.config)}. <span className="prose-muted">{pareto.label}</span>
                    </>
                  ) : (
                    <span className="prose-muted">
                      {' '}
                      — pick a front point on the{' '}
                      <Link className="link" to="/pareto">
                        Pareto
                      </Link>{' '}
                      page and press <em>Send this point to the Compare page</em>.
                    </span>
                  )}
                </label>
              </li>
              <li className="flex items-start gap-2">
                <input
                  id="cmp-manual"
                  type="checkbox"
                  className="mt-0.5 accent-teal-600"
                  checked={includeManual}
                  disabled={running}
                  onChange={(e) => setIncludeManual(e.target.checked)}
                />
                <label htmlFor="cmp-manual">
                  <strong>Manual parameters</strong> <span className="prose-muted">— starts from the baseline; edit below.</span>
                </label>
              </li>
            </ul>
            {includeManual && (
              <div className="max-w-xl border-t border-slate-200 pt-4 dark:border-slate-800">
                <ModelConfigForm bounds={bounds} value={manualCfg} onChange={setManual} idPrefix="cmp" disabled={running} />
              </div>
            )}
          </section>

          <section className="card space-y-3 p-5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-teal-600"
                checked={sameSeed}
                disabled={running}
                onChange={(e) => setSameSeed(e.target.checked)}
              />
              <span>
                Force identical simulator seed across scenarios{' '}
                <span className="prose-muted">(common random numbers make differences attributable to parameters)</span>
              </span>
            </label>
            {sameSeed && (
              <div className="max-w-xs">
                <label className="label" htmlFor="cmp-seed">
                  Common seed
                </label>
                <NumberInput
                  id="cmp-seed"
                  className="input !py-1.5 font-mono !text-sm"
                  value={commonSeed}
                  min={0}
                  max={2 ** 31 - 1}
                  step={1}
                  disabled={running}
                  onChange={(v) => setSeed(Math.round(v))}
                />
              </div>
            )}
          </section>

          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary" disabled={running}>
              {running ? 'Simulating scenarios…' : `⚖️ Compare ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`}
            </button>
            {scenarios.length === 1 && <span className="prose-muted text-xs">Add a second scenario to see deltas.</span>}
          </div>
        </form>
      )}

      {!response && !running && bounds && (
        <Callout tone="info">
          Pick the scenarios to overlay and press <strong>Compare</strong>. Every scenario is one simulation with the same
          model; deltas are reported relative to the baseline.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {response && (
        <section className="space-y-6" aria-label="Comparison results">
          {invalid.length > 0 && (
            <Callout tone="error" role="alert">
              Invalid scenario(s): {invalid.map((s) => `${s.name} (${s.result.failure_reason ?? 'unknown reason'})`).join(', ')}
            </Callout>
          )}

          {figures && (
            <>
              <div className="grid gap-4 xl:grid-cols-3">
                <Plot figure={figures.shortest} />
                <Plot figure={figures.senescence} />
                <Plot figure={figures.proliferative} />
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <Plot figure={figures.length} />
                <Plot figure={figures.population} />
              </div>
            </>
          )}

          <div>
            <h3 className="mb-2 text-base font-semibold">Deltas relative to baseline (model outputs)</h3>
            {valid.length > 1 ? (
              <div className="card overflow-x-auto">
                <table className="w-full text-sm" data-testid="deltas-table">
                  <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2">scenario</th>
                      <th className="px-3 py-2 text-right">fitness</th>
                      {DELTA_COLUMNS.map(([label]) => (
                        <th key={label} className="px-3 py-2 text-right">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {valid
                      .filter((s) => s.deltas)
                      .map((s) => (
                        <tr key={s.name} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-3 py-1.5 font-sans">{s.name}</td>
                          <td className="px-3 py-1.5 text-right">{signed(s.fitness)}</td>
                          {DELTA_COLUMNS.map(([label, key, digits]) => (
                            <td key={label} className="px-3 py-1.5 text-right">
                              {signed(s.deltas![key], digits)}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="prose-muted text-sm">Add a second scenario to see deltas.</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-base font-semibold">Scenario parameters</h3>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm" data-testid="params-table">
                <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">scenario</th>
                    <th className="px-3 py-2 text-right">fitness</th>
                    {PARAM_COLUMNS.map((k) => (
                      <th key={k} className="px-3 py-2 text-right">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {response.scenarios.map((s) => (
                    <tr key={s.name} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="px-3 py-1.5 font-sans">{s.name}</td>
                      <td className="px-3 py-1.5 text-right">{s.fitness === null ? 'invalid' : s.fitness.toFixed(4)}</td>
                      {PARAM_COLUMNS.map((k) => (
                        <td key={k} className="px-3 py-1.5 text-right">
                          {Number.isInteger(s.result.config[k]) ? s.result.config[k] : Number(s.result.config[k]).toFixed(3)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {breakdowns.length > 0 && (
            <div>
              <h3 className="mb-2 text-base font-semibold">Fitness composition</h3>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {breakdowns.map((fig, i) => (
                  <Plot key={valid[i].name} figure={fig} />
                ))}
              </div>
              <p className="prose-muted mt-2 text-xs">
                All values are outputs of the simulation model under the default objective weights. They are not predictions
                about any organism or patient.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
