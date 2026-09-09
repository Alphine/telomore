import type { ReactNode } from 'react'

import { DISCLAIMER_PARTS } from '../features'

type Tone = 'info' | 'success' | 'error' | 'warning'

const TONES: Record<Tone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100',
  error: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
}

export function Callout({
  tone = 'info',
  children,
  role,
}: {
  tone?: Tone
  children: ReactNode
  role?: 'alert' | 'status'
}) {
  return (
    <div role={role} className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${TONES[tone]}`}>
      {children}
    </div>
  )
}

/** The DISCLAIMER from app/ui/components.py, verbatim. */
export function Disclaimer() {
  const d = DISCLAIMER_PARTS
  return (
    <Callout tone="info">
      <span aria-hidden className="mr-1.5">
        ℹ️
      </span>
      <strong>{d.lead}</strong>
      {d.body1}
      <em>{d.em}</em>
      {d.body2}
    </Callout>
  )
}
