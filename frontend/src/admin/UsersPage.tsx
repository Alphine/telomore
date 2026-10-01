import {
  createColumnHelper,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import type { SortingState, Updater } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { PlanBadge } from '../components/PlanBadge'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/Select'
import { useToast } from '../components/ui/Toast'
import { CreateUserDialog } from './CreateUserDialog'
import { UserDrawer } from './UserDrawer'
import { listUsers, patchUser, unlessAll } from './api'
import { accessPlanOf, errorMessage, fmtDate, fmtDateTime } from './format'
import { useAdminQuery, useDebounced } from './hooks'
import { EmptyState, ErrorCard, Pager, RowsSkeleton, TABLE, TD, TH, TR_BORDER } from './shared'
import type { AdminUser, Page, UserPatch } from './types'

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature })
const col = createColumnHelper<typeof features, AdminUser>()

const DEFAULT_SORT = '-created_at'

function statusBadges(u: AdminUser) {
  return (
    <span className="flex flex-wrap gap-1">
      {u.is_disabled && <Badge tone="red">Disabled</Badge>}
      {!u.is_verified && <Badge tone="amber">Unverified</Badge>}
      {u.pending_request && <Badge tone="violet">Request</Badge>}
      {!u.is_disabled && u.is_verified && !u.pending_request && <Badge tone="green">Active</Badge>}
    </span>
  )
}

const columns = col.columns([
  col.accessor('username', {
    header: 'User',
    sortDescFirst: false,
    cell: (c) => (
      <span className="flex flex-col">
        <span className="font-medium">{c.getValue()}</span>
        {c.row.original.is_admin && <span className="text-xs text-violet-700 dark:text-violet-300">admin</span>}
      </span>
    ),
  }),
  col.accessor('email', { header: 'Email', sortDescFirst: false, cell: (c) => <span className="break-all">{c.getValue()}</span> }),
  col.display({
    id: 'plan',
    header: 'Plan',
    enableSorting: false,
    cell: (c) => {
      const u = c.row.original
      return (
        <span className="flex flex-col items-start gap-0.5">
          <PlanBadge plan={accessPlanOf(u)} />
          {u.plan_expires_at && <span className="text-xs text-slate-500">until {fmtDate(u.plan_expires_at)}</span>}
        </span>
      )
    },
  }),
  col.display({ id: 'status', header: 'Status', enableSorting: false, cell: (c) => statusBadges(c.row.original) }),
  col.accessor('created_at', { header: 'Joined', sortDescFirst: true, cell: (c) => <span className="whitespace-nowrap">{fmtDate(c.getValue())}</span> }),
  col.accessor('last_seen_at', {
    header: 'Last seen',
    sortDescFirst: true,
    cell: (c) => <span className="whitespace-nowrap">{c.getValue() ? fmtDateTime(c.getValue()) : 'never'}</span>,
  }),
])

const PLAN_OPTIONS = [
  { value: 'all', label: 'All plans' },
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
]
const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'verified', label: 'Verified' },
  { value: 'unverified', label: 'Unverified' },
  { value: 'admin', label: 'Admins' },
]

function sortToState(sort: string): SortingState {
  return [{ id: sort.replace(/^-/, ''), desc: sort.startsWith('-') }]
}

/** Best-guess row after a patch, shown immediately while the request is in flight. */
function applyOptimistic(u: AdminUser, b: UserPatch): AdminUser {
  const next: AdminUser = { ...u }
  if (b.plan !== undefined) {
    next.plan = b.plan
    next.plan_effective = b.plan
    next.plan_expires_at = b.plan === 'free' ? null : (b.plan_expires_at ?? null)
  } else if (b.plan_expires_at !== undefined) {
    next.plan_expires_at = b.plan_expires_at
  }
  if (b.is_disabled !== undefined) next.is_disabled = b.is_disabled
  if (b.note !== undefined) next.note = b.note
  return next
}

export default function UsersPage() {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [plan, setPlan] = useState('all')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const query = useDebounced(search.trim(), 300)
  const params = { query, plan: unlessAll(plan), status: unlessAll(status), sort, page, page_size: pageSize }
  const q = useAdminQuery(() => listUsers(params), JSON.stringify(params))
  const { setData } = q

  function replaceRow(u: AdminUser) {
    setData((p: Page<AdminUser> | null) => (p ? { ...p, items: p.items.map((x) => (x.id === u.id ? u : x)) } : p))
  }

  async function applyPatch(user: AdminUser, body: UserPatch): Promise<AdminUser | null> {
    replaceRow(applyOptimistic(user, body))
    try {
      const saved = await patchUser(user.id, body)
      replaceRow(saved)
      toast({ tone: 'success', title: `Updated ${saved.username}` })
      return saved
    } catch (err) {
      replaceRow(user)
      toast({ tone: 'error', title: `Could not update ${user.username}`, description: errorMessage(err) })
      return null
    }
  }

  const items = useMemo(() => q.data?.items ?? [], [q.data])

  const table = useTable({
    features,
    columns,
    data: items,
    manualSorting: true,
    manualPagination: true,
    rowCount: q.data?.total ?? 0,
    state: { sorting: sortToState(sort), pagination: { pageIndex: page - 1, pageSize } },
    onSortingChange: (u: Updater<SortingState>) => {
      const next = typeof u === 'function' ? u(sortToState(sort)) : u
      setSort(next[0] ? `${next[0].desc ? '-' : ''}${next[0].id}` : DEFAULT_SORT)
      setPage(1)
    },
  })

  const filtersActive = query !== '' || plan !== 'all' || status !== 'all'
  const selectedRow = selected === null ? null : (items.find((u) => u.id === selected) ?? null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            aria-label="Search users"
            placeholder="Search username or email"
            className="input !pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <Select
          aria-label="Plan filter"
          value={plan}
          onValueChange={(v) => {
            setPlan(v)
            setPage(1)
          }}
          options={PLAN_OPTIONS}
        />
        <Select
          aria-label="Status filter"
          value={status}
          onValueChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={STATUS_OPTIONS}
        />
        <div className="ml-auto">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Create user
          </Button>
        </div>
      </div>

      {q.error && !q.data ? (
        <ErrorCard error={q.error} onRetry={q.reload} title="Could not load users" />
      ) : (
        <Card className="overflow-hidden" aria-busy={q.loading}>
          {!q.data ? (
            <RowsSkeleton label="Loading users" />
          ) : (
            <>
              {q.error && <ErrorCard error={q.error} onRetry={q.reload} title="Refresh failed" />}
              {items.length === 0 ? (
                <EmptyState title={filtersActive ? 'No users match these filters' : 'No users yet'}>
                  {filtersActive ? 'Try a different search or clear the filters.' : 'Create the first account with the button above.'}
                </EmptyState>
              ) : (
                <div className={'overflow-x-auto transition-opacity ' + (q.loading ? 'opacity-60' : '')}>
                  <table className={TABLE}>
                    <caption className="sr-only">Users</caption>
                    <thead className="bg-slate-50 dark:bg-slate-900/60">
                      {table.getHeaderGroups().map((hg) => (
                        <tr key={hg.id}>
                          {hg.headers.map((h) => {
                            const sorted = h.column.getIsSorted()
                            const canSort = h.column.getCanSort()
                            const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown
                            return (
                              <th
                                key={h.id}
                                scope="col"
                                className={TH}
                                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : canSort ? 'none' : undefined}
                              >
                                {canSort ? (
                                  <button
                                    type="button"
                                    onClick={h.column.getToggleSortingHandler()}
                                    className="-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase tracking-wide hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:hover:text-slate-100"
                                  >
                                    {flexRender(h.column.columnDef.header, h.getContext())}
                                    <Icon className={'h-3 w-3 ' + (sorted ? 'text-teal-600 dark:text-teal-400' : 'opacity-50')} aria-hidden />
                                  </button>
                                ) : (
                                  flexRender(h.column.columnDef.header, h.getContext())
                                )}
                              </th>
                            )
                          })}
                        </tr>
                      ))}
                    </thead>
                    <tbody>
                      {table.getRowModel().rows.map((row) => {
                        const u = row.original
                        const open = () => setSelected(u.id)
                        return (
                          <tr
                            key={row.id}
                            id={`user-row-${u.id}`}
                            tabIndex={0}
                            aria-label={`Open ${u.username}`}
                            onClick={open}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                open()
                              }
                            }}
                            className={
                              TR_BORDER +
                              ' cursor-pointer hover:bg-slate-50 focus-visible:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 dark:hover:bg-slate-800/50 dark:focus-visible:bg-teal-500/10' +
                              (u.is_disabled ? ' text-slate-500' : '')
                            }
                          >
                            {row.getAllCells().map((cell) => (
                              <td key={cell.id} className={TD}>
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <Pager
                page={q.data.page}
                pages={q.data.pages}
                total={q.data.total}
                pageSize={pageSize}
                noun="users"
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

      <UserDrawer userId={selected} user={selectedRow} onClose={() => setSelected(null)} onPatch={applyPatch} />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={q.reload} />
    </div>
  )
}
