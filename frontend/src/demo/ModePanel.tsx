import { m } from 'framer-motion'
import { FlaskConical, Lock, RefreshCw, Sparkles, Zap } from 'lucide-react'
import { useContext } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { useAccess } from '../access/context'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { useEnter } from '../lib/motion'
import { cn } from '../lib/cn'
import { GateContext, useDemo } from './context'

/** Title of the demo banner. Kept in one place: tests and docs quote it. */
export const DEMO_BANNER_TITLE = 'Precomputed example – not live compute'

/** CTA shown in the banner and next to locked forms, depending on who is looking. */
export function AccessCta({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  const { plan, user } = useAccess()
  const location = useLocation()
  const pending = !!user?.pending_request
  if (plan === 'anonymous') {
    const next = encodeURIComponent(location.pathname + location.search)
    return (
      <Link
        to={`/login?next=${next}`}
        className={cn(
          'inline-flex items-center justify-center rounded-lg bg-teal-600 font-medium text-white shadow-sm hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400',
          size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
          className,
        )}
      >
        Log in
      </Link>
    )
  }
  return (
    <Link
      to="/account#access"
      className={cn(
        'inline-flex items-center justify-center rounded-lg bg-teal-600 font-medium text-white shadow-sm hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
        className,
      )}
    >
      {pending ? 'View access request' : 'Request Pro access'}
    </Link>
  )
}

function Picker() {
  const demo = useDemo()
  const enter = useEnter()
  if (!demo) return null

  if (demo.status === 'loading') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading examples">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }
  if (demo.status === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
        <span>Could not load the precomputed examples ({demo.error}). They are published with the site; try again in a moment.</span>
        <Button variant="outline" size="sm" onClick={demo.retry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
        </Button>
      </div>
    )
  }
  if (demo.status === 'empty') {
    return (
      <div role="status" className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
        No precomputed examples are published for this feature yet. Pro users can run it live.
      </div>
    )
  }
  return (
    <div role="radiogroup" aria-label="Example scenarios" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {demo.scenarios.map((s, i) => {
        const selected = s.id === demo.selectedId
        return (
          <m.button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => demo.select(s.id)}
            {...enter}
            transition={{ ...enter.transition, delay: i * 0.04 }}
            className={cn(
              'group rounded-xl border p-4 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
              selected
                ? 'border-teal-500 bg-teal-50/70 ring-1 ring-teal-500 dark:border-teal-400 dark:bg-teal-500/10 dark:ring-teal-400'
                : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700',
            )}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="font-heading text-sm font-semibold">{s.title}</span>
              {selected && <Badge tone="teal">Showing</Badge>}
            </span>
            <span title={s.description} className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{s.description}</span>
          </m.button>
        )
      })}
    </div>
  )
}

function DemoPanel() {
  const demo = useDemo()
  const { canLive, setPreferredMode } = useAccess()
  const sc = demo?.scenario
  return (
    <section aria-label="Demo mode" className="space-y-4" data-testid="demo-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 px-4 py-3 dark:border-amber-500/30 dark:from-amber-500/10 dark:to-orange-500/5">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">{DEMO_BANNER_TITLE}</p>
            <p className="text-xs leading-relaxed text-amber-900/80 dark:text-amber-100/70">
              These results were computed ahead of time by the same engine. The inputs are locked; live runs need a Pro plan.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canLive ? (
            <Button size="sm" variant="outline" onClick={() => setPreferredMode('live')}>
              <Zap className="h-3.5 w-3.5" aria-hidden /> Switch to live
            </Button>
          ) : (
            <AccessCta />
          )}
        </div>
      </div>
      <Picker />
      {sc && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <summary className="cursor-pointer select-none font-medium">
            <FlaskConical className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            Scenario request (read-only)
          </summary>
          <pre className="mono-block mt-3 max-h-72 overflow-auto text-xs">{JSON.stringify(sc.request, null, 2)}</pre>
        </details>
      )}
      {demo?.scenarioStatus === 'loading' && (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
          Loading example…
        </p>
      )}
      {demo?.scenarioStatus === 'error' && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          This example could not be loaded. Pick another one or retry.{' '}
          <button type="button" className="underline" onClick={demo.retry}>
            Retry
          </button>
        </p>
      )}
    </section>
  )
}

function LiveBar() {
  const { setPreferredMode, canLive } = useAccess()
  if (!canLive) return null
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-2.5 dark:border-teal-500/30 dark:bg-teal-500/5"
      data-testid="live-bar"
    >
      <p className="flex items-center gap-2 text-sm text-teal-900 dark:text-teal-100">
        <Zap className="h-4 w-4" aria-hidden /> Live mode: runs execute on the server.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <span id="mode-switch-label">Show precomputed examples</span>
        <Switch aria-labelledby="mode-switch-label" checked={false} onCheckedChange={() => setPreferredMode('demo')} />
      </label>
    </div>
  )
}

/** Rendered by <PageHeader>; renders nothing outside a <FeatureGate>. */
export function ModePanel() {
  const gated = useContext(GateContext)
  const demo = useDemo()
  if (!gated) return null
  return demo ? <DemoPanel /> : <LiveBar />
}

/** A small lock note placed at the top of a locked form. */
export function LockedFormNote() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
      <span className="flex items-center gap-1.5">
        <Lock className="h-3.5 w-3.5" aria-hidden /> Inputs are the example&apos;s own and read-only.
      </span>
      <AccessCta />
    </div>
  )
}
