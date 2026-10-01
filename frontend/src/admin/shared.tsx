import { AlertCircle, ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import type { ReactNode } from 'react'

import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { errorMessage, statusTone } from './format'

export function ErrorCard({ error, onRetry, title = 'Could not load this data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <Card role="alert" className="flex flex-wrap items-center gap-3 border-rose-200 p-4 dark:border-rose-500/30">
      <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-slate-600 dark:text-slate-400">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Card>
  )
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <div className="text-slate-400 dark:text-slate-500">{icon ?? <Inbox className="h-8 w-8" aria-hidden />}</div>
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-slate-600 dark:text-slate-400">{children}</p>}
    </div>
  )
}

export function RowsSkeleton({ rows = 6, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

const PAGE_SIZE_OPTIONS = ['10', '25', '50', '100'].map((v) => ({ value: v, label: `${v} / page` }))

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
  onPageSize,
  noun = 'rows',
}: {
  page: number
  pages: number
  total: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize?: (n: number) => void
  noun?: string
}) {
  const last = Math.max(1, pages)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <p className="text-slate-600 dark:text-slate-400" data-testid="pager-count">
        {total.toLocaleString('en-US')} {total === 1 ? noun.replace(/s$/, '') : noun}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSize && (
          <Select
            aria-label="Rows per page"
            value={String(pageSize)}
            onValueChange={(v) => onPageSize(Number(v))}
            options={PAGE_SIZE_OPTIONS}
            className="min-w-[8.5rem]"
          />
        )}
        <Button variant="outline" size="sm" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span aria-live="polite" className="tabular-nums">
          Page {page} of {last}
        </span>
        <Button variant="outline" size="sm" aria-label="Next page" disabled={page >= last} onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}

export function StatusCodeBadge({ code }: { code: number }) {
  return (
    <Badge tone={statusTone(code)} className="tabular-nums">
      {code}
    </Badge>
  )
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  )
}

/** Shared table styling. */
export const TH = 'whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
export const TD = 'px-4 py-2.5 align-middle'
export const TABLE = 'w-full min-w-[40rem] border-collapse text-sm'
export const TR_BORDER = 'border-t border-slate-100 dark:border-slate-800'

/** Free / Pro segmented radio group. */
export function PlanToggle({ value, onChange, label = 'Plan' }: { value: 'free' | 'pro'; onChange: (p: 'free' | 'pro') => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-900">
      {(['free', 'pro'] as const).map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={
            'rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ' +
            (value === p
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-50'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100')
          }
        >
          {p}
        </button>
      ))}
    </div>
  )
}
