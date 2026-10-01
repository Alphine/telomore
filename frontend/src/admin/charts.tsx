// Tiny hand-written SVG/CSS charts (no Plotly: the admin chunk stays small).
// Colours come from currentColor / Tailwind classes so both themes work.
import { useId, useState } from 'react'

import { cn } from '../lib/cn'
import { fmtMs } from './format'

export interface Point {
  label: string
  value: number
  /** Optional subset of `value` drawn in red (errors). */
  alt?: number
}

interface ChartBase {
  title: string
  desc: string
  className?: string
  height?: number
}

/** Vertical bars, one per point, with a hover/focus readout. */
export function BarChart({ data, title, desc, className, height = 120, altLabel = 'errors' }: ChartBase & { data: Point[]; altLabel?: string }) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const W = 600
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = Math.max(1, data.length)
  const step = W / n
  const bw = Math.max(1, step * 0.72)
  const total = data.reduce((a, d) => a + d.value, 0)
  const shown = active !== null ? data[active] : null
  return (
    <figure className={cn('m-0', className)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="block h-auto w-full text-teal-500 dark:text-teal-400"
        preserveAspectRatio="none"
        onMouseLeave={() => setActive(null)}
      >
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`${desc} Total ${total}, peak ${max}.`}</desc>
        <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth="1" />
        {data.map((d, i) => {
          const h = d.value === 0 ? 1 : Math.max(2, (d.value / max) * (height - 6))
          const eh = d.alt && d.value > 0 ? (d.alt / max) * (height - 6) : 0
          const x = i * step + (step - bw) / 2
          return (
            <g key={d.label} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
              <rect x={i * step} y={0} width={step} height={height} fill="transparent" />
              <rect
                x={x}
                y={height - h}
                width={bw}
                height={h}
                rx={1.5}
                fill="currentColor"
                opacity={active === null || active === i ? 1 : 0.55}
              >
                <title>{`${d.label}: ${d.value}${d.alt ? ` (${d.alt} ${altLabel})` : ''}`}</title>
              </rect>
              {eh > 0 && <rect x={x} y={height - eh} width={bw} height={eh} rx={1.5} className="fill-rose-500" />}
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
        <span>{shown ? `${shown.label}: ${shown.value}${shown.alt ? ` (${shown.alt} ${altLabel})` : ''}` : (data[0]?.label ?? '')}</span>
        <span>{shown ? '' : (data[data.length - 1]?.label ?? '')}</span>
      </figcaption>
    </figure>
  )
}

/** Filled line chart for a single series. */
export function Sparkline({ data, title, desc, className, height = 96 }: ChartBase & { data: Point[] }) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const W = 600
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = data.length
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => height - 4 - (v / max) * (height - 12)
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ')
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z` : ''
  const total = data.reduce((a, d) => a + d.value, 0)
  const shown = active !== null ? data[active] : null
  return (
    <figure className={cn('m-0', className)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="block h-auto w-full text-teal-500 dark:text-teal-400"
        preserveAspectRatio="none"
        onMouseLeave={() => setActive(null)}
      >
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`${desc} Total ${total}, peak ${max}.`}</desc>
        <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth="1" />
        {area && <path d={area} fill="currentColor" opacity="0.14" />}
        {line && <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {data.map((d, i) => (
          <g key={d.label} onMouseEnter={() => setActive(i)}>
            <rect x={x(i) - W / n / 2} y={0} width={W / Math.max(n, 1)} height={height} fill="transparent">
              <title>{`${d.label}: ${d.value}`}</title>
            </rect>
          </g>
        ))}
        {active !== null && shown && <circle cx={x(active)} cy={y(shown.value)} r="4" fill="currentColor" />}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
        <span>{shown ? `${shown.label}: ${shown.value}` : (data[0]?.label ?? '')}</span>
        <span>{shown ? '' : (data[data.length - 1]?.label ?? '')}</span>
      </figcaption>
    </figure>
  )
}

export interface LatencyRow {
  endpoint: string
  count: number
  p50_ms: number
  p95_ms: number
}

/** Horizontal p95 bars with a p50 tick, sorted slowest first. */
export function LatencyBars({ rows }: { rows: LatencyRow[] }) {
  const sorted = [...rows].sort((a, b) => b.p95_ms - a.p95_ms)
  const max = Math.max(1, ...sorted.map((r) => r.p95_ms))
  return (
    <ul className="m-0 list-none space-y-3 p-0" aria-label="p95 latency per endpoint">
      {sorted.map((r) => {
        const w = (r.p95_ms / max) * 100
        const m = Math.min(100, (r.p50_ms / max) * 100)
        return (
          <li key={r.endpoint}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-mono" title={r.endpoint}>
                {r.endpoint}
              </span>
              <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-400">
                p95 {fmtMs(r.p95_ms)} <span className="text-slate-400">/ p50 {fmtMs(r.p50_ms)} / n={r.count}</span>
              </span>
            </div>
            <div
              className="relative h-2.5 rounded-full bg-slate-100 dark:bg-slate-800"
              role="img"
              aria-label={`${r.endpoint}: p95 ${fmtMs(r.p95_ms)}, p50 ${fmtMs(r.p50_ms)}`}
            >
              <div className="h-full rounded-full bg-teal-500/80 dark:bg-teal-400/80" style={{ width: `${Math.max(w, 1)}%` }} />
              <div
                className="absolute top-[-3px] h-[16px] w-[3px] rounded bg-slate-900 dark:bg-slate-50"
                style={{ left: `calc(${m}% - 1.5px)` }}
                aria-hidden
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
