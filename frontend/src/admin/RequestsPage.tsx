import { Check, Inbox, X } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Dialog, DialogContent } from '../components/ui/Dialog'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/Tabs'
import { useToast } from '../components/ui/Toast'
import { approveRequest, listRequests, rejectRequest } from './api'
import { ageLabel, errorMessage, fmtDateTime } from './format'
import { useAdminQuery } from './hooks'
import { EmptyState, ErrorCard, Field, Pager, RowsSkeleton } from './shared'
import type { AccessRequestItem, Page, RequestStatus } from './types'

type Tab = RequestStatus | 'all'
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
]

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'No expiry', days: null },
]

const TONE = { pending: 'amber', approved: 'green', rejected: 'red' } as const

function ApproveDialog({ req, onClose, onConfirm }: { req: AccessRequestItem | null; onClose: () => void; onConfirm: (days: number | null, note: string | null) => void }) {
  const [days, setDays] = useState<string>('30')
  const [note, setNote] = useState('')
  const n = days.trim() === '' ? null : Number(days)
  const valid = n === null || (Number.isInteger(n) && n >= 1 && n <= 3650)
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && onClose()}>
      {req && (
        <DialogContent
          title={`Approve ${req.username}`}
          description="Grants Pro. Leave the duration empty for no expiry."
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!valid} onClick={() => onConfirm(n, note.trim() === '' ? null : note.trim())}>
                Approve
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Plan days (1 to 3650)" htmlFor="ap-days" hint={valid ? undefined : 'Enter a whole number between 1 and 3650, or clear the field.'}>
              <input
                id="ap-days"
                type="number"
                min={1}
                max={3650}
                inputMode="numeric"
                className="input"
                placeholder="No expiry"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={!valid}
              />
            </Field>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Duration presets">
              {PRESETS.map((p) => (
                <Button key={p.label} size="sm" variant="outline" onClick={() => setDays(p.days === null ? '' : String(p.days))}>
                  {p.label}
                </Button>
              ))}
            </div>
            <Field label="Note (optional)" htmlFor="ap-note">
              <textarea id="ap-note" className="input min-h-20" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

function RejectDialog({ req, onClose, onConfirm }: { req: AccessRequestItem | null; onClose: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Dialog open={req !== null} onOpenChange={(o) => !o && onClose()}>
      {req && (
        <DialogContent
          title={`Reject ${req.username}`}
          description="The user sees your note next to the decision."
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => onConfirm(note.trim())}>
                Reject
              </Button>
            </>
          }
        >
          <Field label="Note" htmlFor="rj-note">
            <textarea id="rj-note" className="input min-h-24" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </DialogContent>
      )}
    </Dialog>
  )
}

export default function RequestsPage() {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('pending')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [approving, setApproving] = useState<AccessRequestItem | null>(null)
  const [rejecting, setRejecting] = useState<AccessRequestItem | null>(null)

  const params = { status: tab, page, page_size: pageSize }
  const q = useAdminQuery(() => listRequests(params), JSON.stringify(params))
  const { setData } = q

  const removeFromList = (id: number) =>
    setData((p: Page<AccessRequestItem> | null) => (p ? { ...p, total: Math.max(0, p.total - 1), items: p.items.filter((r) => r.id !== id) } : p))

  /** Pending tab: drop the card at once and put it back (at the same spot) if the call fails. */
  async function decide(req: AccessRequestItem, call: () => Promise<AccessRequestItem>, verb: string, action: string) {
    const removable = tab === 'pending'
    const snapshot = q.data
    if (removable) removeFromList(req.id)
    try {
      const done = await call()
      if (!removable) setData((p: Page<AccessRequestItem> | null) => (p ? { ...p, items: p.items.map((r) => (r.id === done.id ? done : r)) } : p))
      toast({ tone: 'success', title: `${verb} ${req.username}` })
    } catch (err) {
      if (removable) setData(() => snapshot)
      toast({ tone: 'error', title: `Could not ${action} ${req.username}`, description: errorMessage(err) })
      if ((err as { status?: number }).status === 409) q.reload() // already decided elsewhere: show real state
    }
  }

  const items = q.data?.items ?? []

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab)
          setPage(1)
        }}
      >
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="Request status">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      {q.error && !q.data ? (
        <ErrorCard error={q.error} onRetry={q.reload} title="Could not load requests" />
      ) : !q.data ? (
        <Card>
          <RowsSkeleton rows={3} label="Loading requests" />
        </Card>
      ) : (
        <>
          {items.length === 0 ? (
            <Card>
              <EmptyState title={tab === 'pending' ? 'No pending requests' : 'No requests here'} icon={<Inbox className="h-8 w-8" aria-hidden />}>
                {tab === 'pending' ? 'New Pro access requests will show up here.' : 'Nothing matches this status yet.'}
              </EmptyState>
            </Card>
          ) : (
            <ul className={'m-0 list-none space-y-3 p-0 transition-opacity ' + (q.loading ? 'opacity-60' : '')} aria-label="Access requests">
              {items.map((r) => (
                <li key={r.id}>
                  <Card className="p-4" data-testid={`request-${r.id}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{r.username}</span>
                          <Badge tone={TONE[r.status]}>{r.status}</Badge>
                        </p>
                        <p className="break-all text-sm text-slate-600 dark:text-slate-400">{r.email}</p>
                      </div>
                      <p className="text-xs text-slate-500" title={r.created_at}>
                        {ageLabel(r.created_at)}
                      </p>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm">{r.message || <span className="text-slate-500">No message.</span>}</p>
                    {r.status !== 'pending' && (
                      <p className="mt-2 text-xs text-slate-500">
                        {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decided_by_username ?? 'unknown'} on {fmtDateTime(r.decided_at)}
                        {r.decision_note ? `: ${r.decision_note}` : ''}
                      </p>
                    )}
                    {r.status === 'pending' && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => setApproving(r)} aria-label={`Approve ${r.username}`}>
                          <Check className="h-4 w-4" aria-hidden /> Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRejecting(r)} aria-label={`Reject ${r.username}`}>
                          <X className="h-4 w-4" aria-hidden /> Reject
                        </Button>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {q.data.total > 0 && (
            <Card>
              <Pager
                page={q.data.page}
                pages={q.data.pages}
                total={q.data.total}
                pageSize={pageSize}
                noun="requests"
                onPage={setPage}
                onPageSize={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
              />
            </Card>
          )}
        </>
      )}

      <ApproveDialog
        key={approving?.id ?? 'none-a'}
        req={approving}
        onClose={() => setApproving(null)}
        onConfirm={(days, note) => {
          const r = approving
          setApproving(null)
          if (r) void decide(r, () => approveRequest(r.id, { plan_days: days, note }), 'Approved', 'approve')
        }}
      />
      <RejectDialog
        key={rejecting?.id ?? 'none-r'}
        req={rejecting}
        onClose={() => setRejecting(null)}
        onConfirm={(note) => {
          const r = rejecting
          setRejecting(null)
          if (r) void decide(r, () => rejectRequest(r.id, { note }), 'Rejected', 'reject')
        }}
      />
    </div>
  )
}
