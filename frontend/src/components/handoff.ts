// Cross-page hand-offs the Streamlit app kept in st.session_state, stored in
// sessionStorage like the baseline (components/baseline.ts, key
// `tel_baseline_config`) so they survive client-side navigation and a reload
// of this tab but not a new session:
//
//   tel_evolve_best          Evolve -> Compare ("Best evolved" scenario;
//                            st.session_state["evo_result"]). Written by the
//                            Evolve page whenever a job completes, and by its
//                            "Send best to Compare" button.
//   tel_compare_user_config  Pareto -> Compare ("From Pareto page" scenario;
//                            st.session_state["compare_user_config"]).
//
// Both hold a full ModelConfig (genome already merged into the base config,
// as GenomeSpec.to_config did) plus a short provenance label.
import type { ModelConfig } from '../api/types'

export const EVOLVE_BEST_KEY = 'tel_evolve_best'
export const COMPARE_USER_CONFIG_KEY = 'tel_compare_user_config'

export interface ScenarioHandoff {
  config: ModelConfig
  /** Where it came from, e.g. "Evolve run TEL-20260910-003 (fitness +0.612)". */
  label: string
  run_id: string | null
}

function load(key: string): ScenarioHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const h = parsed as Partial<ScenarioHandoff>
    if (!h.config || typeof h.config !== 'object') return null
    return { config: h.config, label: h.label ?? '', run_id: h.run_id ?? null }
  } catch {
    return null
  }
}

function save(key: string, value: ScenarioHandoff): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable -- the scenario just will not carry over */
  }
}

function clear(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export const loadEvolveBest = () => load(EVOLVE_BEST_KEY)
export const saveEvolveBest = (v: ScenarioHandoff) => save(EVOLVE_BEST_KEY, v)
export const clearEvolveBest = () => clear(EVOLVE_BEST_KEY)

export const loadCompareUserConfig = () => load(COMPARE_USER_CONFIG_KEY)
export const saveCompareUserConfig = (v: ScenarioHandoff) => save(COMPARE_USER_CONFIG_KEY, v)
export const clearCompareUserConfig = () => clear(COMPARE_USER_CONFIG_KEY)

/** GenomeSpec.to_config(genome, seed): the base config with the free genes overwritten. */
export function genomeToConfig(base: ModelConfig, genome: Record<string, number>, seed?: number): ModelConfig {
  const cfg: ModelConfig = { ...base, ...(genome as Partial<ModelConfig>) }
  if (seed !== undefined) cfg.seed = seed
  return cfg
}

export function signed(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a'
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`
}

/** Same parsing as the Streamlit forms: comma-separated ints, blanks ignored; null on a non-integer. */
export function parseIntList(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const ints = parts.map((s) => Number(s))
  if (ints.some((n) => !Number.isInteger(n))) return null
  return ints
}
