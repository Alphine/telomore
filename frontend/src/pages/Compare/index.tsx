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
import { useChipPresets } from '../../api/useChipPresets'
import { Callout } from '../../components/Callout'
import { ModelConfigForm } from '../../components/ModelConfigForm'
import { NumberInput } from '../../components/NumberInput'
import { PageHeader } from '../../components/PageHeader'
import { loadBaseline } from '../../components/baseline'
import { BIOLOGICAL_AGE_DISCLAIMER } from '../../components/biologicalAgeUtils'
import { Plot } from '../../components/charts/Plot'
import { overlayChart } from '../../components/charts/compareCharts'
import { protocolOverlayChart } from '../../components/charts/scheduleCharts'
import { fitnessBreakdownBar } from '../../components/charts/simulationCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { loadCompareUserConfig, loadEvolveBest, signed } from '../../components/handoff'
import { isScheduled, meanApplied } from '../../components/scheduleUtils'
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

// Time-averaged doses of the schedulable parameters (docs/MODEL.md §2.1),
// shown in the parameter table when at least one scenario is scheduled. Each
// mean is taken over the applied per-cycle values the API returned.
const MEAN_COLUMNS: Array<[string, 'stress_level' | 'maintenance_rate' | 'repair_rate']> = [
  ['s̄ (mean stress)', 'stress_level'],
  ['m̄ (mean maintenance)', 'maintenance_rate'],
  ['r̄ (mean repair)', 'repair_rate'],
]

function summary(c: ModelConfig): string {
  const base = `stress=${c.stress_level.toFixed(3)}, maintenance=${c.maintenance_rate.toFixed(3)}, repair=${c.repair_rate.toFixed(3)}`
  return isScheduled(c) ? `${base} (phase 0 of a ${c.schedule.phases}-phase protocol: ${Object.keys(c.schedule.values).join(', ')})` : base
}

export function Compare() {
  const { bounds, error: boundsError } = useBounds()
  const { presets: chipPresets, error: chipPresetsError } = useChipPresets()
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

  // Organ-chip preset scenarios (ROADMAP.md candidate feature #3: run several
  // chip condition profiles side by side). Each entry is one added scenario;
  // the same preset may be added more than once (e.g. to bracket two
  // durations), so entries are a list of {id, presetKey}, not a set.
  const [chipEntries, setChipEntries] = useState<Array<{ id: string; presetKey: string }>>([])
  const [chipPickerKey, setChipPickerKey] = useState('')

  const baseline = bounds ? (loadBaseline() ?? bounds.demo) : null
  const manualCfg = manual ?? baseline
  const commonSeed = seed ?? baseline?.seed ?? 42

  function addChipScenario() {
    if (!chipPickerKey) return
    setChipEntries((es) => [...es, { id: `${chipPickerKey}-${es.length}-${Date.now()}`, presetKey: chipPickerKey }])
  }
  function removeChipScenario(id: string) {
    setChipEntries((es) => es.filter((e) => e.id !== id))
  }

  // {label} for the first occurrence of a preset, "{label} (2)" etc. after
  // that, so scenario names stay unique (the server rejects duplicates).
  const chipScenarios = useMemo<CompareScenario[]>(() => {
    if (!chipPresets) return []
    const seen: Record<string, number> = {}
    const out: CompareScenario[] = []
    for (const entry of chipEntries) {
      const preset = chipPresets.presets[entry.presetKey]
      if (!preset) continue
      seen[preset.label] = (seen[preset.label] ?? 0) + 1
      const name = seen[preset.label] > 1 ? `${preset.label} (${seen[preset.label]})` : preset.label
      out.push({ name, chip: preset.conditions })
    }
    return out
  }, [chipEntries, chipPresets])

  const scenarios = useMemo<CompareScenario[]>(() => {
    if (!baseline) return []
    const out: CompareScenario[] = [{ name: 'Baseline', config: baseline }]
    if (includeEvolved && evolved) out.push({ name: 'Best evolved', config: evolved.config })
    if (includePareto && pareto) out.push({ name: 'From Pareto page', config: pareto.config })
    if (includeManual && manualCfg) out.push({ name: 'Manual', config: manualCfg })
    out.push(...chipScenarios)
    return out
  }, [baseline, includeEvolved, evolved, includePareto, pareto, includeManual, manualCfg, chipScenarios])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!scenarios.length) return
    setRunning(true)
    setError(null)
    try {
      const res = await apiCompare({
        scenarios,
        seed: sameSeed ? commonSeed : undefined,
        // Chip scenarios' derived {stress_level, repair_rate, cycles} are
        // merged onto this base -- the same override the Simulate page's
        // ChipMapper does client-side, done server-side here instead.
        base_config: baseline ?? undefined,
      })
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
  const anyScheduled = useMemo(() => (response?.scenarios ?? []).some((s) => isScheduled(s.result.config)), [response])

  const figures = useMemo(() => {
    if (!valid.length || !baseline) return null
    const runs = valid.map((s) => ({ name: s.name, run: s.result }))
    return {
      protocol: runs.some(({ run }) => Object.keys(run.applied_schedule ?? {}).length) ? protocolOverlayChart(runs, dark) : null,
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

          <section className="card space-y-3 p-5" aria-label="Organ-chip preset scenarios">
            <h2 className="text-lg font-semibold">Organ-chip presets</h2>
            <p className="prose-muted text-xs">
              Illustrative organ-chip condition profiles — a documented modelling assumption, not a validated
              physiological model (docs/MODEL.md §6). Add one or more to compare their derived parameters side by side.
            </p>
            {chipPresetsError && (
              <Callout tone="error" role="alert">
                Could not load organ-chip presets: {chipPresetsError}
              </Callout>
            )}
            {chipPresets && (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="label" htmlFor="cmp-chip-picker">
                    Preset
                  </label>
                  <select
                    id="cmp-chip-picker"
                    className="input !py-1.5 !text-sm"
                    value={chipPickerKey}
                    disabled={running}
                    onChange={(e) => setChipPickerKey(e.target.value)}
                  >
                    <option value="">Choose a preset…</option>
                    {Object.entries(chipPresets.presets).map(([key, preset]) => (
                      <option key={key} value={key}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !text-sm"
                  disabled={running || !chipPickerKey}
                  onClick={addChipScenario}
                >
                  + Add scenario
                </button>
                {chipPickerKey && (
                  <p className="prose-muted basis-full text-xs">{chipPresets.presets[chipPickerKey]?.description}</p>
                )}
              </div>
            )}
            {chipEntries.length > 0 && (
              <ul className="space-y-2 text-sm" data-testid="chip-scenario-list">
                {chipEntries.map((entry, i) => {
                  const preset = chipPresets?.presets[entry.presetKey]
                  const name = chipScenarios[i]?.name ?? preset?.label ?? entry.presetKey
                  return (
                    <li key={entry.id} className="flex items-start justify-between gap-2 rounded-md border border-slate-200 p-2 dark:border-slate-800">
                      <div>
                        <strong>{name}</strong>
                        {preset && (
                          <dl className="mt-1 grid grid-cols-3 gap-2 font-mono text-xs">
                            <div>
                              <dt className="prose-muted">stress_level</dt>
                              <dd>{preset.derived.stress_level.toFixed(3)}</dd>
                            </div>
                            <div>
                              <dt className="prose-muted">repair_rate</dt>
                              <dd>{preset.derived.repair_rate.toFixed(3)}</dd>
                            </div>
                            <div>
                              <dt className="prose-muted">cycles</dt>
                              <dd>{preset.derived.cycles}</dd>
                            </div>
                          </dl>
                        )}
                      </div>
                      <button
                        type="button"
                        className="link text-xs"
                        disabled={running}
                        onClick={() => removeChipScenario(entry.id)}
                        aria-label={`Remove ${name}`}
                      >
                        Remove
                      </button>
                    </li>
                  )
                })}
              </ul>
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
              {figures.protocol && (
                <div className="space-y-2" aria-label="Applied protocols">
                  <Plot figure={figures.protocol} />
                  <p className="prose-muted text-xs">
                    Dashed step lines: the value in force at each cycle for every scheduled parameter of a scheduled
                    scenario (constant scenarios are not drawn). Cost is charged on the time averages (s̄ / m̄ / r̄ below).
                  </p>
                </div>
              )}
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
                    <th className="px-3 py-2 text-right" title={BIOLOGICAL_AGE_DISCLAIMER}>
                      synthetic age index
                    </th>
                    {PARAM_COLUMNS.map((k) => (
                      <th key={k} className="px-3 py-2 text-right">
                        {k}
                      </th>
                    ))}
                    {anyScheduled &&
                      MEAN_COLUMNS.map(([label]) => (
                        <th key={label} className="px-3 py-2 text-right">
                          {label}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {response.scenarios.map((s) => {
                    const cfg = s.result.config
                    const applied = s.result.applied_schedule ?? {}
                    const age = s.result.biological_age
                    return (
                      <tr key={s.name} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-sans">
                          {s.name}
                          {isScheduled(cfg) && (
                            <span className="prose-muted ml-1 text-[10px]" title="scheduled: scalar columns show the phase-0 value">
                              ({cfg.schedule.phases}-phase protocol)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right">{s.fitness === null ? 'invalid' : s.fitness.toFixed(4)}</td>
                        <td className="px-3 py-1.5 text-right" data-testid={`age-${s.name}`}>
                          {age && age.valid && age.final_score !== null ? age.final_score.toFixed(1) : '—'}
                        </td>
                        {PARAM_COLUMNS.map((k) => (
                          <td key={k} className="px-3 py-1.5 text-right">
                            {Number.isInteger(cfg[k]) ? String(cfg[k]) : Number(cfg[k]).toFixed(3)}
                            {k in applied && <span title="phase-0 value; see the mean column">†</span>}
                          </td>
                        ))}
                        {anyScheduled &&
                          MEAN_COLUMNS.map(([label, k]) => {
                            const m = k in applied ? meanApplied(applied[k]) : cfg[k]
                            return (
                              <td key={label} className="px-3 py-1.5 text-right" data-testid={`mean-${k}`}>
                                {m === null ? '' : m.toFixed(3)}
                              </td>
                            )
                          })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {anyScheduled && (
              <p className="prose-muted mt-1 text-xs">
                † scheduled parameter — the scalar column shows its phase-0 value; the s̄ / m̄ / r̄ columns are the time
                averages over the applied per-cycle values (what the cost term is charged on).
              </p>
            )}
            <p className="prose-muted mt-1 text-xs" data-testid="biological-age-disclaimer">
              Synthetic age index (0-100 per scenario above): {BIOLOGICAL_AGE_DISCLAIMER}
            </p>
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
