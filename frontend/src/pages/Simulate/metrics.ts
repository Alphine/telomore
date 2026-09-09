import type { SimulationRun } from '../../api/types'
import type { Metric } from '../../components/MetricRow'

/** app/ui/components.py::terminal_metric_row (six metrics incl. fitness). */
export function terminalMetrics(run: SimulationRun): Metric[] {
  const tm = run.terminal_metrics
  const t50 = tm.time_to_50pct_senescence
  return [
    { label: 'Final mean length', value: `${((tm.final_mean_length_bp ?? 0) / 1000).toFixed(2)} kb` },
    { label: 'Mean shortest / cell', value: `${((tm.final_mean_shortest_bp ?? 0) / 1000).toFixed(2)} kb` },
    { label: 'Senescent fraction', value: `${((tm.final_senescent_fraction ?? 0) * 100).toFixed(1)}%` },
    // inf ("never reached") arrives as null from the API.
    { label: 'Cycles to 50 % senescent', value: t50 === null || t50 === undefined ? 'not reached' : String(Math.trunc(t50)) },
    { label: 'Final living cells', value: String(tm.final_population_size ?? 0) },
    { label: 'Fitness (objective)', value: `${run.fitness.total >= 0 ? '+' : ''}${run.fitness.total.toFixed(3)}` },
  ]
}

/** app/ui/components.py::provenance -- the CLI command that reproduces the run. */
export function reproduceCommand(run: SimulationRun): string {
  const sets = Object.entries(run.config)
    .filter(([k]) => k !== 'seed')
    .map(([k, v]) => `--set ${k}=${v}`)
    .join(' ')
  return `python scripts/run_simulation.py --seed ${run.seed} ${sets}`
}
