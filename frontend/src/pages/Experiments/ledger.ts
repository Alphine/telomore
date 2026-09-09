// Non-component helpers for the Experiments page.
import type { ExperimentRecord } from '../../api/types'

/**
 * The CLI command that reproduces a ledger record, derived the same way the
 * Streamlit page did (a record stores its configuration, not a command):
 * simulations get `run_simulation.py --seed --set k=v ...`; the optimizer
 * kinds get their `scripts/run_*.py --config <file>.yaml` with the recorded
 * seed, where <file> is the record's `configuration` blocks written to YAML.
 * Returns null for a kind without a script.
 */
export function reproductionCommand(record: ExperimentRecord): string | null {
  const cfg = record.configuration ?? {}
  switch (record.kind) {
    case 'simulation': {
      const model = (cfg.model ?? {}) as Record<string, unknown>
      const seed = model.seed ?? record.seed
      const sets = Object.entries(model)
        .filter(([k]) => k !== 'seed')
        .map(([k, v]) => `--set ${k}=${String(v)}`)
        .join(' ')
      return `python scripts/run_simulation.py --seed ${String(seed)} ${sets}`.trim()
    }
    case 'evolution':
      return `# write the configuration blocks of this record to a YAML file, then\npython scripts/run_evolution.py --config <file>.yaml --seed ${record.seed}`
    case 'pareto':
      return `# write the configuration blocks of this record to a YAML file, then\npython scripts/run_pareto.py --config <file>.yaml --seed ${record.seed}`
    case 'sensitivity':
      return `# write the configuration blocks of this record to a YAML file, then\npython scripts/run_sensitivity.py --config <file>.yaml`
    case 'active_learning':
      return `# write the configuration blocks of this record to a YAML file, then\npython scripts/run_active_learning.py --config <file>.yaml --seed ${record.seed}`
    default:
      return null
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** "2026-09-10T00:19:09" -> "2026-09-10 00:19" */
export function shortTime(iso: string | null): string {
  if (!iso) return ''
  return iso.replace('T', ' ').slice(0, 16)
}
