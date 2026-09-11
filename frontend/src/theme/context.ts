import { createContext, useContext } from 'react'

// Three-way theme preference (system/light/dark), see ThemeProvider.tsx for
// the resolution logic and frontend/README.md for the user-facing summary.
export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'tel_theme'

export interface ThemeState {
  preference: ThemePreference
  setPreference: (t: ThemePreference) => void
  /** True when the resolved theme is dark -- 'dark', or 'system' matching the OS. */
  resolvedDark: boolean
}

export const ThemeContext = createContext<ThemeState | null>(null)

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

function prefersDarkOS(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Reads the persisted preference, defaulting to 'system' (no stored value, or an unusable one). */
export function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // localStorage unavailable (privacy mode, disabled storage, etc.) -- fall back to system.
  }
  return 'system'
}

export function resolveDark(preference: ThemePreference): boolean {
  return preference === 'dark' || (preference === 'system' && prefersDarkOS())
}

/**
 * Applies the resolved theme to <html> as early as possible -- called at the
 * very top of main.tsx, before React mounts, so the page never paints one
 * theme and then flips to another once ThemeProvider's effect runs.
 */
export function applyInitialThemeClass(): void {
  if (typeof document === 'undefined') return
  const dark = resolveDark(readStoredPreference())
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
