import { m } from 'framer-motion'
import { Link } from 'react-router-dom'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { useEnter } from '../lib/motion'
import { getStats } from './api'
import { BarChart, LatencyBars, Sparkline } from './charts'
import { fmtInt, fmtPct } from './format'
import { useAdminQuery } from './hooks'
import { EmptyState, ErrorCard } from './shared'
import type { AdminStats } from './types'

interface Kpi {
  id: string
  label: string
  value: string
  hint?: string
  to?: string
  tone?: 'warn' | 'bad'
}

function kpis(s: AdminStats): Kpi[] {
  return [
    { id: 'users-total', label: 'Users', value: fmtInt(s.users.total), hint: `${fmtInt(s.users.verified)} verified` },
    { id: 'users-free', label: 'Free', value: fmtInt(s.users.free) },
    { id: 'users-pro', label: 'Pro', value: fmtInt(s.users.pro), hint: 'includes admins' },
    { id: 'users-disabled', label: 'Disabled', value: fmtInt(s.users.disabled), tone: s.users.disabled > 0 ? 'warn' : undefined },
    { id: 'requests-pending', label: 'Pending requests', value: fmtInt(s.requests.pending), to: 'requests', tone: s.requests.pending > 0 ? 'warn' : undefined },
    { id: 'requests-24h', label: 'Requests, 24 h', value: fmtInt(s.requests.last_24h) },
    { id: 'requests-7d', label: 'Requests, 7 d', value: fmtInt(s.requests.last_7d) },
    { id: 'jobs-running', label: 'Jobs running', value: fmtInt(s.jobs.running), hint: `${fmtInt(s.jobs.queued)} queued` },
    {
      id: 'error-rate',
      label: `Error rate, ${s.error_rate.window_days} d`,
      value: fmtPct(s.error_rate.rate),
      hint: `${fmtInt(s.error_rate.errors)} of ${fmtInt(s.error_rate.total)} calls`,
      tone: s.error_rate.rate >= 0.05 ? 'bad' : undefined,
    },
  ]
}

function KpiCard({ k }: { k: Kpi }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{k.label}</p>
      <p
        className={
          'mt-1 font-heading text-2xl font-semibold tabular-nums ' +
          (k.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : k.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : '')
        }
      >
        {k.value}
      </p>
      {k.hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{k.hint}</p>}
    </>
  )
  const base = 'block rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900'
  return k.to ? (
    <Link
      to={k.to}
      data-testid={`kpi-${k.id}`}
      className={base + ' transition hover:border-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'}
    >
      {body}
    </Link>
  ) : (
    <div data-testid={`kpi-${k.id}`} className={base}>
      {body}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading overview" className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-52 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  )
}

export default function OverviewPage() {
  const q = useAdminQuery(getStats, 'stats')
  const enter = useEnter()

  if (q.error && !q.data) return <ErrorCard error={q.error} onRetry={q.reload} title="Could not load the overview" />
  if (!q.data) return <OverviewSkeleton />
  const s = q.data

  const signups = s.signups_per_day.map((d) => ({ label: d.date, value: d.count }))
  const compute = s.compute_events_per_day.map((d) => ({ label: d.date, value: d.count }))
  const signupTotal = signups.reduce((a, d) => a + d.value, 0)
  const computeTotal = compute.reduce((a, d) => a + d.value, 0)

  return (
    <m.div {...enter} className="space-y-6">
      {q.error ? <ErrorCard error={q.error} onRetry={q.reload} title="Refresh failed, showing older numbers" /> : null}
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {kpis(s).map((k) => (
          <KpiCard key={k.id} k={k} />
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signups per day</CardTitle>
            <CardDescription>Last 30 days, {fmtInt(signupTotal)} total</CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline data={signups} title="Signups per day" desc="New accounts per day over the last 30 days." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Compute events per day</CardTitle>
            <CardDescription>Simulations and LLM calls, last 30 days, {fmtInt(computeTotal)} total</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart data={compute} title="Compute events per day" desc="Compute and LLM events per day over the last 30 days." />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Latency by endpoint</CardTitle>
            <CardDescription>Last 7 days. Bar is p95, the dark tick marks p50.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.latency_by_endpoint.length === 0 ? (
              <EmptyState title="No traffic yet">Latency shows up once API calls have been logged.</EmptyState>
            ) : (
              <LatencyBars rows={s.latency_by_endpoint} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top users</CardTitle>
            <CardDescription>Most compute events, last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            {s.top_users.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ol className="m-0 list-none space-y-1 p-0">
                {s.top_users.map((u, i) => (
                  <li key={u.user_id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                      <span className="truncate font-medium">{u.username}</span>
                    </span>
                    <span className="tabular-nums text-slate-600 dark:text-slate-400">{fmtInt(u.count)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </m.div>
  )
}
