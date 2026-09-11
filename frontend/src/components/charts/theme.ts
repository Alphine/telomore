// Plotly layout defaults mirroring app/ui/charts.py (PALETTE + _LAYOUT), plus
// a light/dark switch. plotly.js has no named-template registry like the
// Python `template="plotly_white"`, so the equivalent colours are set
// explicitly here and swapped for dark mode.
import { useContext, useEffect, useState } from 'react'
import type { Layout } from 'plotly.js-dist-min'

import { ThemeContext } from '../../theme/context'

export const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2']
export const CURSOR_COLOR = '#14b8a6' // teal-500, matches the app accent

/**
 * True when the resolved theme is dark. Sourced from the app's
 * `<ThemeProvider>` (frontend/src/theme/) so it stays in sync with the
 * manual system/light/dark toggle -- falls back to a raw
 * `prefers-color-scheme` read (the old behaviour) if no provider is mounted,
 * which some tests render this component tree without.
 */
export function usePrefersDark(): boolean {
  const ctx = useContext(ThemeContext)
  const [fallbackDark, setFallbackDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    if (ctx) return // a ThemeProvider is present; its own resolvedDark is authoritative
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setFallbackDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [ctx])
  return ctx ? ctx.resolvedDark : fallbackDark
}

export interface LayoutOptions {
  dark: boolean
  title: string
  xTitle?: string
  yTitle?: string
  height?: number
  showLegend?: boolean
}

export function baseLayout(o: LayoutOptions): Partial<Layout> {
  const text = o.dark ? '#cbd5e1' : '#334155' // slate-300 / slate-700
  const grid = o.dark ? '#334155' : '#e2e8f0' // slate-700 / slate-200
  const axis = { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: text } }
  return {
    title: { text: o.title, font: { color: o.dark ? '#f1f5f9' : '#0f172a', size: 15 }, x: 0.02, xanchor: 'left' },
    margin: { l: 40, r: 20, t: 50, b: 40 },
    height: o.height ?? 340,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: o.dark ? '#0f172a' : '#ffffff',
    font: { color: text, family: 'Inter, ui-sans-serif, system-ui, sans-serif', size: 12 },
    showlegend: o.showLegend ?? true,
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'left', x: 0, font: { color: text } },
    hovermode: 'x unified',
    xaxis: { ...axis, title: o.xTitle ? { text: o.xTitle } : undefined },
    yaxis: { ...axis, title: o.yTitle ? { text: o.yTitle } : undefined },
  }
}

/** Horizontal reference line across the whole plot (Plotly Python's add_hline). */
export function hline(y: number, annotation?: string) {
  return {
    shape: {
      type: 'line' as const,
      xref: 'paper' as const,
      yref: 'y' as const,
      x0: 0,
      x1: 1,
      y0: y,
      y1: y,
      line: { color: 'gray', dash: 'dash' as const, width: 1 },
    },
    annotation: annotation
      ? {
          xref: 'paper' as const,
          yref: 'y' as const,
          x: 1,
          y,
          xanchor: 'right' as const,
          yanchor: 'top' as const,
          text: annotation,
          showarrow: false,
          font: { size: 11, color: 'gray' },
        }
      : null,
  }
}

/** Vertical reference line (Plotly Python's add_vline). */
export function vline(x: number, color = 'gray', dash: 'dash' | 'solid' = 'dash', width = 1) {
  return {
    type: 'line' as const,
    xref: 'x' as const,
    yref: 'paper' as const,
    x0: x,
    x1: x,
    y0: 0,
    y1: 1,
    line: { color, dash, width },
  }
}
