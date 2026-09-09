// The "baseline" ModelConfig shared between Simulate and Evolve (the Streamlit
// app kept it in st.session_state["baseline_config"], set via "Set as
// baseline" on the Simulate page). Kept in sessionStorage so it survives
// client-side navigation and a reload of this tab but not a new session --
// matching the Streamlit per-session semantics.
//
// TODO(Phase 4 -- Compare page): the Streamlit Compare page also read this
// baseline and a "best evolved" scenario; wire those there, not here.
import type { ModelConfig } from '../api/types'

const KEY = 'tel_baseline_config'

export function loadBaseline(): ModelConfig | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ModelConfig) : null
  } catch {
    return null
  }
}

export function saveBaseline(config: ModelConfig): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(config))
  } catch {
    /* storage unavailable -- the baseline just will not carry over */
  }
}

export function clearBaseline(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
