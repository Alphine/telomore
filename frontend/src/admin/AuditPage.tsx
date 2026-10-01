import { useState } from 'react'

import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/Select'
import { listAudit, unlessAll } from './api'
import { fmtDateTime, formatDetail } from './format'
import { useAdminQuery } from './hooks'
import { EmptyState, ErrorCard, Pager, RowsSkeleton, TABLE, TD, TH, TR_BORDER } from './shared'
import { AUDIT_ACTIONS } from './types'
import type { AuditAction } from './types'

const ACTION_OPTIONS = [{ value: 'all', label: 'All actions' }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: a }))]
const TONE: Record<AuditAction, 'teal' | 'green' | 'red' | 'violet' | 'neutral'> = {
  user_update: 'teal',
  user_create: 'green',
  request_approve: 'green',
  request_reject: 'red',
  usage_export: 'violet',
}

export default function AuditPage() {
  const [action, setAction] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const params = { action: unlessAll(action), page, page_size: pageSize }
  const q = useAdminQuery(() => listAudit(params), JSON.stringify(params))
  const items = q.data?.items ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Action filter"
          value={action}
          onValueChange={(v) => {
            setAction(v)
            setPage(1)
          }}
          options={ACTION_OPTIONS}
          className="min-w-[12rem]"
        />
      </div>

      {q.error && !q.data ? (
        <ErrorCard error={q.error} onRetry={q.reload} title="Could not load the audit log" />
      ) : (
        <Card className="overflow-hidden" aria-busy={q.loading}>
          {!q.data ? (
            <RowsSkeleton label="Loading audit log" />
          ) : (
            <>
              {items.length === 0 ? (
                <EmptyState title="No audit entries">Every admin change is recorded here.</EmptyState>
              ) : (
                <div tabIndex={0} role="region" aria-label="Audit log table (scrollable)" className={'overflow-x-auto transition-opacity ' + (q.loading ? 'opacity-60' : '')}>
                  <table className={TABLE + ' min-w-[44rem]'}>
                    <caption className="sr-only">Audit log, newest first</caption>
                    <thead className="bg-slate-50 dark:bg-slate-900/60">
                      <tr>
                        {['Time (UTC)', 'Admin', 'Action', 'Target', 'Detail'].map((h) => (
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
                          <td className={TD}>{e.admin_username}</td>
                          <td className={TD}>
                            <Badge tone={TONE[e.action] ?? 'neutral'}>{e.action}</Badge>
                          </td>
                          <td className={TD}>{e.target_username ?? <span className="text-slate-400">-</span>}</td>
                          <td className={TD + ' max-w-xs break-words font-mono text-xs text-slate-600 dark:text-slate-400'}>{formatDetail(e.detail) || '-'}</td>
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
                noun="entries"
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
