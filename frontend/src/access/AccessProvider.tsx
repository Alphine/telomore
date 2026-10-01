import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { PRO_REQUIRED_EVENT } from '../api/client'
import { useAuth } from '../auth/context'
import { useToast } from '../components/ui/Toast'
import { clearPersistentState } from '../state/usePersistentState'
import { AccessContext, MODE_STORAGE_KEY, derivePlan } from './context'
import type { AccessMode, AccessState } from './context'

function readMode(): AccessMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'demo' ? 'demo' : 'live'
  } catch {
    return 'live'
  }
}

/**
 * Single source of truth for "may this visitor run live compute?".
 * Anonymous and free users are always in demo mode; pro users and admins start
 * in live mode and can flip to demo. A 403 `pro_required` from the API (plan
 * expired or revoked while the page was open) forces demo until the account is
 * re-read and says otherwise.
 */
export function AccessProvider({ children }: { children: ReactNode }) {
  const { status, user, refresh } = useAuth()
  const { toast } = useToast()
  const [preferredMode, setPreferred] = useState<AccessMode>(readMode)
  const [forcedDemoFor, setForcedDemoFor] = useState<string | null>(null)

  const { plan, canLive } = useMemo(() => derivePlan(user), [user])
  // A forced demo is tied to the plan signature it happened under, so a real plan change lifts it.
  const signature = `${user?.id ?? 'anon'}:${user?.plan ?? ''}:${user?.plan_expires_at ?? ''}:${user?.is_admin ? 1 : 0}`
  const forced = forcedDemoFor === signature

  const setPreferredMode = useCallback((m: AccessMode) => {
    clearPersistentState() // a demo result must not leak into live mode (and vice versa)
    setPreferred(m)
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, m)
    } catch {
      /* storage unavailable: the choice just lasts for this session */
    }
  }, [])

  const reportProRequired = useCallback(() => {
    clearPersistentState()
    setForcedDemoFor(signature)
    toast({
      tone: 'info',
      title: 'Pro access needed',
      description: 'Live compute needs an active Pro plan. Showing precomputed examples; request access on your account page.',
    })
    void refresh()
  }, [signature, toast, refresh])

  useEffect(() => {
    const onEvent = () => reportProRequired()
    window.addEventListener(PRO_REQUIRED_EVENT, onEvent)
    return () => window.removeEventListener(PRO_REQUIRED_EVENT, onEvent)
  }, [reportProRequired])

  const mode: AccessMode = canLive && !forced && preferredMode === 'live' ? 'live' : 'demo'

  const value = useMemo<AccessState>(
    () => ({
      status,
      user,
      plan,
      isAdmin: plan === 'admin',
      canLive,
      mode,
      preferredMode,
      setPreferredMode,
      reportProRequired,
    }),
    [status, user, plan, canLive, mode, preferredMode, setPreferredMode, reportProRequired],
  )
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}
