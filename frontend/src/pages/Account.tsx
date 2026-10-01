import { motion } from 'framer-motion'
import { LogOut } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { AccessRequestForm } from '../account/AccessRequestForm'
import { useAccess } from '../access/context'
import { myAccessRequests } from '../api/endpoints'
import type { AccessRequest, AccessRequestStatus } from '../api/types'
import { useAuth } from '../auth/context'
import { PlanBadge } from '../components/PlanBadge'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { useEnter } from '../lib/motion'

const STATUS_TONE: Record<AccessRequestStatus, 'amber' | 'green' | 'red'> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'n/a'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function Account() {
  const { user, logout, refresh } = useAuth()
  const { plan, canLive } = useAccess()
  const navigate = useNavigate()
  const enter = useEnter()
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    myAccessRequests()
      .then((r) => {
        setRequests(r)
        setLoadError(null)
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Could not load your requests.'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!user) return null
  const pending = requests?.find((r) => r.status === 'pending') ?? null
  const hasPendingFlag = !!user.pending_request
  const showForm = !canLive && !pending && !(requests === null && hasPendingFlag)

  return (
    <motion.div {...enter} className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Account</h1>
        <p className="prose-muted mt-1">Your plan, access requests and session.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              <code className="font-mono">{user.username}</code>
            </CardTitle>
            <PlanBadge />
          </div>
          <CardDescription>{user.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-slate-500">Plan</dt>
            <dd className="font-medium capitalize">{plan === 'anonymous' ? 'free' : plan}</dd>
            <dt className="text-slate-500">Expires</dt>
            <dd className="font-medium">{canLive ? (user.plan_expires_at ? fmtDate(user.plan_expires_at) : 'Does not expire') : 'n/a'}</dd>
            <dt className="text-slate-500">Live compute</dt>
            <dd className="font-medium">{canLive ? 'Enabled' : 'Precomputed examples only'}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card id="access" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Pro access</CardTitle>
          <CardDescription>
            {canLive
              ? 'Your plan includes live compute on every feature.'
              : 'Free accounts browse precomputed examples. Pro unlocks live simulations, optimisers and the experiment ledger.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {requests === null && !loadError && <Skeleton className="h-16" />}
          {loadError && (
            <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
              {loadError}
            </p>
          )}
          {!canLive && pending && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" role="status">
              Your request is pending review. You can send a new one once it has been decided.
            </p>
          )}
          {showForm && (
            <AccessRequestForm
              onSubmitted={() => {
                load()
                void refresh()
              }}
            />
          )}
          {requests && requests.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Your requests</h3>
              <ul className="space-y-2" aria-label="Access requests">
                {requests.map((r) => (
                  <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={STATUS_TONE[r.status]} data-testid={`request-status-${r.id}`}>
                        {r.status}
                      </Badge>
                      <span className="text-xs text-slate-500">{fmtDate(r.created_at)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-slate-700 dark:text-slate-300">{r.message}</p>
                    {r.decision_note && (
                      <p className="mt-2 text-xs text-slate-500">Admin note: {r.decision_note}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <Button
          variant="outline"
          onClick={() => {
            logout()
            navigate('/')
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden /> Log out
        </Button>
      </div>
    </motion.div>
  )
}
