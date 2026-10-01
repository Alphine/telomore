import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { PlanBadge } from '../components/PlanBadge'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Dialog, DialogContent } from '../components/ui/Dialog'
import { Skeleton } from '../components/ui/Skeleton'
import { getUser } from './api'
import { accessPlanOf, addDaysIso, ageLabel, endOfDayIso, fmtDate, fmtDateTime, fmtMs } from './format'
import { useAdminQuery } from './hooks'
import { ErrorCard, PlanToggle, StatusCodeBadge } from './shared'
import type { AccessRequestItem, AdminUser, AdminUserDetail, UserPatch } from './types'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-slate-200 py-4 first:border-t-0 first:pt-0 dark:border-slate-800">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
      <dd className="m-0 min-w-0 break-all text-right">{v}</dd>
    </div>
  )
}

const QUICK = [30, 90, 365]

function PlanEditor({ user, onPatch }: { user: AdminUser; onPatch: (b: UserPatch) => Promise<unknown> }) {
  const [plan, setPlan] = useState<'free' | 'pro'>(user.plan)
  const [expiry, setExpiry] = useState(user.plan_expires_at ? fmtDate(user.plan_expires_at) : '')
  const [busy, setBusy] = useState(false)
  const dirty = plan !== user.plan || (plan === 'pro' && expiry !== (user.plan_expires_at ? fmtDate(user.plan_expires_at) : ''))

  async function save() {
    setBusy(true)
    const body: UserPatch = plan === 'free' ? { plan: 'free' } : { plan: 'pro', plan_expires_at: expiry ? endOfDayIso(expiry) : null }
    await onPatch(body)
    setBusy(false)
  }

  if (user.is_admin) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <ShieldCheck className="h-4 w-4" aria-hidden /> Admin accounts always have Pro and cannot be changed here.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <PlanToggle value={plan} onChange={setPlan} label="Plan" />
      {plan === 'pro' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="ud-expiry" className="label">
                Expires on
              </label>
              <input id="ud-expiry" type="date" className="input !w-auto" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick expiry">
            {QUICK.map((d) => (
              <Button key={d} size="sm" variant="outline" onClick={() => setExpiry(addDaysIso(d).slice(0, 10))}>
                +{d} days
              </Button>
            ))}
            <Button size="sm" variant="outline" onClick={() => setExpiry('')}>
              No expiry
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{expiry ? `Pro until the end of ${expiry} (UTC).` : 'Pro without an expiry date.'}</p>
        </div>
      )}
      <Button size="sm" onClick={save} disabled={!dirty || busy}>
        {busy ? 'Saving...' : 'Save plan'}
      </Button>
    </div>
  )
}

function NoteEditor({ user, onPatch }: { user: AdminUser; onPatch: (b: UserPatch) => Promise<unknown> }) {
  const [note, setNote] = useState(user.note ?? '')
  const [busy, setBusy] = useState(false)
  const dirty = note !== (user.note ?? '')
  async function save() {
    setBusy(true)
    await onPatch({ note: note.trim() === '' ? null : note })
    setBusy(false)
  }
  return (
    <div className="space-y-2">
      <label htmlFor="ud-note" className="sr-only">
        Admin note
      </label>
      <textarea id="ud-note" className="input min-h-20" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Private note about this user" />
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{note.length}/500</span>
        <Button size="sm" variant="outline" onClick={save} disabled={!dirty || busy}>
          Save note
        </Button>
      </div>
    </div>
  )
}

function RequestList({ items }: { items: AccessRequestItem[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">No access requests.</p>
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {items.map((r) => (
        <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}>{r.status}</Badge>
            <span className="text-xs text-slate-500">{fmtDateTime(r.created_at)}</span>
          </div>
          {r.message && <p className="mt-1.5 break-words">{r.message}</p>}
          {r.decision_note && <p className="mt-1 text-xs text-slate-500">Decision: {r.decision_note}</p>}
        </li>
      ))}
    </ul>
  )
}

function UsageList({ items }: { items: AdminUserDetail['recent_usage'] }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">No recorded activity.</p>
  return (
    <div tabIndex={0} role="region" aria-label="Recent activity table (scrollable)" className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full min-w-[26rem] text-xs">
        <caption className="sr-only">Recent activity</caption>
        <thead className="sticky top-0 bg-slate-50 text-left text-slate-500 dark:bg-slate-900">
          <tr>
            <th className="px-2 py-1.5 font-medium">When</th>
            <th className="px-2 py-1.5 font-medium">Endpoint</th>
            <th className="px-2 py-1.5 font-medium">Status</th>
            <th className="px-2 py-1.5 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="whitespace-nowrap px-2 py-1.5">{fmtDateTime(e.ts)}</td>
              <td className="px-2 py-1.5 font-mono">
                {e.method} {e.endpoint}
              </td>
              <td className="px-2 py-1.5">
                <StatusCodeBadge code={e.status_code} />
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{fmtMs(e.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UserDrawer({
  userId,
  user,
  onClose,
  onPatch,
}: {
  userId: number | null
  /** Live row from the list (optimistically updated); falls back to the fetched detail. */
  user: AdminUser | null
  onClose: () => void
  onPatch: (user: AdminUser, body: UserPatch) => Promise<unknown>
}) {
  return (
    <Dialog open={userId !== null} onOpenChange={(o) => !o && onClose()}>
      {userId !== null && (
        <DialogContent
          variant="drawer"
          title="User details"
          description="Profile, plan, notes, recent activity and access requests."
          onCloseAutoFocus={(e) => {
            const row = document.getElementById(`user-row-${userId}`)
            if (row) {
              e.preventDefault()
              row.focus()
            }
          }}
        >
          <DrawerBody key={userId} userId={userId} user={user} onPatch={onPatch} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function DrawerBody({ userId, user, onPatch }: { userId: number; user: AdminUser | null; onPatch: (u: AdminUser, b: UserPatch) => Promise<unknown> }) {
  const q = useAdminQuery(() => getUser(userId), `user-${userId}`)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [busy, setBusy] = useState(false)
  const u: AdminUser | null = user ?? q.data
  const detail = q.data

  if (!u) {
    if (q.error) return <ErrorCard error={q.error} onRetry={q.reload} title="Could not load this user" />
    return (
      <div role="status" aria-label="Loading user" className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }
  const patch = (b: UserPatch) => onPatch(u, b)

  async function toggleDisabled() {
    if (!u) return
    setBusy(true)
    await onPatch(u, { is_disabled: !u.is_disabled })
    setBusy(false)
    setConfirmDisable(false)
  }

  return (
    <div>
      <div className="mb-4">
        <p className="font-heading text-lg font-semibold">{u.username}</p>
        <p className="break-all text-sm text-slate-600 dark:text-slate-400">{u.email}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <PlanBadge plan={accessPlanOf(u)} />
          {u.is_disabled && <Badge tone="red">Disabled</Badge>}
          <Badge tone={u.is_verified ? 'green' : 'amber'}>{u.is_verified ? 'Verified' : 'Unverified'}</Badge>
          {u.pending_request && <Badge tone="amber">Pro request pending</Badge>}
        </div>
      </div>

      <Section title="Profile">
        <dl className="m-0">
          <Row k="User id" v={u.id} />
          <Row k="Plan" v={`${u.plan}${u.plan !== u.plan_effective ? ` (effective ${u.plan_effective})` : ''}`} />
          <Row k="Plan expires" v={u.plan_expires_at ? fmtDateTime(u.plan_expires_at) : 'never'} />
          <Row k="Joined" v={fmtDateTime(u.created_at)} />
          <Row k="Last login" v={u.last_login_at ? `${fmtDateTime(u.last_login_at)} (${ageLabel(u.last_login_at)})` : 'never'} />
          <Row k="Last seen" v={u.last_seen_at ? `${fmtDateTime(u.last_seen_at)} (${ageLabel(u.last_seen_at)})` : 'never'} />
          <Row k="Saved runs" v={detail ? detail.runs_count : '...'} />
        </dl>
      </Section>

      <Section title="Plan">
        <PlanEditor key={`${u.id}-${u.plan}-${u.plan_expires_at}`} user={u} onPatch={patch} />
      </Section>

      <Section title="Account">
        {u.is_admin ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">Admin accounts cannot be disabled.</p>
        ) : (
          <Button variant={u.is_disabled ? 'outline' : 'danger'} size="sm" onClick={() => setConfirmDisable(true)}>
            {u.is_disabled ? 'Enable account' : 'Disable account'}
          </Button>
        )}
      </Section>

      <Section title="Note">
        <NoteEditor key={`${u.id}-${u.note ?? ''}`} user={u} onPatch={patch} />
      </Section>

      <Section title="Recent activity">
        {q.error && !detail ? <ErrorCard error={q.error} onRetry={q.reload} /> : detail ? <UsageList items={detail.recent_usage} /> : <Skeleton className="h-24 w-full" />}
      </Section>

      <Section title="Access requests">
        {detail ? <RequestList items={detail.requests} /> : <Skeleton className="h-16 w-full" />}
      </Section>

      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent
          title={u.is_disabled ? `Enable ${u.username}?` : `Disable ${u.username}?`}
          description={
            u.is_disabled
              ? 'They will be able to sign in and use the API again.'
              : 'They are signed out of every request and cannot log in until you enable the account again.'
          }
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDisable(false)}>
                Cancel
              </Button>
              <Button variant={u.is_disabled ? 'primary' : 'danger'} onClick={toggleDisabled} disabled={busy}>
                {u.is_disabled ? 'Enable' : 'Disable'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">This change is recorded in the audit log.</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}
