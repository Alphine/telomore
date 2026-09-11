import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { THEME_STORAGE_KEY, ThemeContext, readStoredPreference } from './context'
import type { ThemePreference, ThemeState } from './context'

interface ThemeProviderProps {
  children: ReactNode
}

/**
 * Three-way theme preference (system/light/dark), persisted to localStorage
 * under `tel_theme`. Applies/removes the `dark` class on <html> so Tailwind's
 * class-based `dark:` variant (see index.css's `@custom-variant dark`) picks
 * it up, and syncs `usePrefersDark()` (components/charts/theme.ts) so every
 * chart/canvas that reads it stays correct without touching those call sites.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference())
  const [osDark, setOsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  // Track the OS preference continuously; only 'system' actually consumes it
  // (see resolvedDark below), but there is no harm keeping it fresh.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolvedDark = preference === 'dark' || (preference === 'system' && osDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedDark)
    document.documentElement.style.colorScheme = resolvedDark ? 'dark' : 'light'
  }, [resolvedDark])

  const setPreference = useCallback((t: ThemePreference) => {
    setPreferenceState(t)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t)
    } catch {
      // localStorage unavailable -- the in-memory preference still applies for this session.
    }
  }, [])

  const value = useMemo<ThemeState>(
    () => ({ preference, setPreference, resolvedDark }),
    [preference, setPreference, resolvedDark],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
