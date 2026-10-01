import { Download } from 'lucide-react'
import { useState } from 'react'

import { downloadBlob } from '../components/download'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { useToast } from '../components/ui/Toast'
import { exportUsageCsv, getUsageSummary, listUsage, unlessAll } from './api'
import { BarChart } from './charts'
import { errorMessage, fmtDateTime, fmtInt, fmtMs, fmtPct, todayIso } from './format'
import { useAdminQuery, useDebounced } from './hooks'
import { EmptyState, ErrorCard, Pager, RowsSkeleton, StatusCodeBadge, TABLE, TD, TH, TR_BORDER } from './shared'

const STATUS_OPTIONS = [
  { value: 'all', label: 'Any status' },
  { value: '2xx', label: '2xx success' },
  { value: '3xx', label: '3xx redirect' },
  { value: '4xx', label: '4xx client error' },
  { value: '5xx', label: '5xx server error' },
]
const DAY_OPTIONS = [7, 30, 90]

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={'m-0 mt-0.5 font-heading text-xl font-semibold tabular-nums ' + (tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : '')}>{value}</dd>
    </div>
  )
}

function SummaryStrip() {
  const [days, setDays] = useState(7)
  const q = useAdminQuery(() => getUsageSummary(days), `summary-${days}`)
  const s = q.data
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Summary</h2>
        <div role="radiogroup" aria-label="Summary window" className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-900">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className={
                'rounded-md px-3 py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ' +
                (days === d ? 'bg-white shadow-sm dark:bg-slate-800' : 'text-slate-600 dark:text-slate-400')
              }
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      {q.error && !s ? (
        <ErrorCard error={q.error} onRetry={q.reload} title="Could not load the summary" />
      ) : !s ? (
        <div role="status" aria-label="Loading summary" className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : (
        <div className={'grid gap-4 sm:grid-cols-[1fr_2fr] ' + (q.loading ? 'opacity-60' : '')}>
          <dl className="m-0 grid grid-cols-2 gap-3" data-testid="usage-summary">
            <Stat label="Requests" value={fmtInt(s.total)} />
            <Stat label="Errors" value={`${fmtInt(s.errors)} (${fmtPct(s.error_rate)})`} tone={s.errors > 0 ? 'bad' : undefined} />
            <Stat label="Unique users" value={fmtInt(s.unique_users)} />
            <Stat label="Unique IPs" value={fmtInt(s.unique_ips)} />
          </dl>
          {s.total === 0 ? (
            <p className="self-center text-sm text-slate-500">No traffic in this window.</p>
          ) : (
            <BarChart
              height={72}
              data={s.by_day.map((d) => ({ label: d.date, value: d.count, alt: d.errors }))}
              title={`Requests per day, last ${days} days`}
              desc="Requests per day; the red part of each bar is server errors."
            />
          )}
        </div>
      )}
    </Card>
  )
}

export default function UsagePage() {
  const { toast } = useToast()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [userId, setUserId] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [exporting, setExporting] = useState(false)

  const dUser = useDebounced(userId.trim(), 300)
  const dEndpoint = useDebounced(endpoint.trim(), 300)
  const filters = { from, to, user_id: dUser, endpoint: dEndpoint, status: unlessAll(status) }
  const params = { ...filters, page, page_size: pageSize }
  const q = useAdminQuery(() => listUsage(params), JSON.stringify(params))

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPage(1)
  }

  async function doExport() {
    setExporting(true)
    try {
      const blob = await exportUsageCsv(filters)
      downloadBlob(`usage-${todayIso()}.csv`, blob)
      toast({ tone: 'success', title: 'CSV exported' })
    } catch (err) {
      toast({ tone: 'error', title: 'Export failed', description: errorMessage(err) })
    } finally {
      setExporting(false)
    }
  }

  const items = q.data?.items ?? []
  const filtersActive = from !== '' || to !== '' || dUser !== '' || dEndpoint !== '' || status !== 'all'

  return (
    <div className="space-y-4">
      <SummaryStrip />

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="us-from" className="label">
              From
            </label>
            <input id="us-from" type="date" className="input !w-auto" value={from} max={to || undefined} onChange={(e) => reset(setFrom)(e.target.value)} />
          </div>
          <div>
            <label htmlFor="us-to" className="label">
              To
            </label>
            <input id="us-to" type="date" className="input !w-auto" value={to} min={from || undefined} onChange={(e) => reset(setTo)(e.target.value)} />
          </div>
          <div className="w-28">
            <label htmlFor="us-user" className="label">
              User id
            </label>
            <input id="us-user" inputMode="numeric" className="input" value={userId} onChange={(e) => reset(setUserId)(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="us-endpoint" className="label">
              Endpoint
            </label>
            <input id="us-endpoint" className="input font-mono" placeholder="/api/simulate" value={endpoint} onChange={(e) => reset(setEndpoint)(e.target.value)} />
          </div>
          <div>
            <span className="label" id="us-status-l">
              Status
            </span>
            <Select aria-label="Status filter" value={status} onValueChange={reset(setStatus)} options={STATUS_OPTIONS} />
          </div>
          <div className="ml-auto flex gap-2">
            {filtersActive && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom('')
                  setTo('')
                  setUserId('')
                  setEndpoint('')
                  setStatus('all')
                  setPage(1)
                }}
              >
                Clear
              </Button>
            )}
            <Button variant="outline" onClick={doExport} disabled={exporting}>
              <Download className="h-4 w-4" aria-hidden /> {exporting ? 'Exporting...' : 'Export CSV'}
            </Button>
          </div>
        </div>
      </Card>

      {q.error && !q.data ? (
        <ErrorCard error={q.error} onRetry={q.reload} title="Could not load usage events" />
      ) : (
        <Card className="overflow-hidden" aria-busy={q.loading}>
          {!q.data ? (
            <RowsSkeleton label="Loading usage events" />
          ) : (
            <>
              {items.length === 0 ? (
                <EmptyState title="No usage events">{filtersActive ? 'Nothing matches these filters.' : 'Events appear here once the API gets traffic.'}</EmptyState>
              ) : (
                <div className={'overflow-x-auto transition-opacity ' + (q.loading ? 'opacity-60' : '')}>
                  <table className={TABLE + ' min-w-[52rem]'}>
                    <caption className="sr-only">Usage events, newest first</caption>
                    <thead className="bg-slate-50 dark:bg-slate-900/60">
                      <tr>
                        {['Time (UTC)', 'User', 'Request', 'Status', 'Duration', 'Kind', 'IP hash'].map((h) => (
                          <th key={h} scope="col" className={TH}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((e) => (
                        <tr key={e.id} className={TR_BORDER}>
                          <td className={TD + ' whitespace-nowrap'}>{fmtDateTime(e.ts)}</td>
                          <td className={TD}>{e.username ?? <span className="text-slate-400">anonymous</span>}</td>
                          <td className={TD + ' font-mono text-xs'}>
                            <span className="text-slate-500">{e.method}</span> {e.endpoint}
                          </td>
                          <td className={TD}>
                            <StatusCodeBadge code={e.status_code} />
                          </td>
                          <td className={TD + ' whitespace-nowrap tabular-nums'}>{fmtMs(e.duration_ms)}</td>
                          <td className={TD}>
                            <Badge>{e.kind}</Badge>
                          </td>
                          <td className={TD + ' font-mono text-xs text-slate-500'}>{e.ip_hash ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pager
                page={q.data.page}
                pages={q.data.pages}
                total={q.data.total}
                pageSize={pageSize}
                noun="events"
                onPage={setPage}
                onPageSize={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
              />
            </>
          )}
        </Card>
      )}
    </div>
  )
}
