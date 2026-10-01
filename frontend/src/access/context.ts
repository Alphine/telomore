import { createContext, useContext } from 'react'

import type { AuthStatus } from '../auth/context'
import type { UserResponse } from '../api/types'

/** Who is looking: drives what every feature page may do. */
export type AccessPlan = 'anonymous' | 'free' | 'pro' | 'admin'
/** `live` calls the real API; `demo` shows cached, precomputed scenarios only. */
export type AccessMode = 'live' | 'demo'

export interface AccessState {
  status: AuthStatus
  user: UserResponse | null
  plan: AccessPlan
  isAdmin: boolean
  /** Pro or admin, and the plan has not expired: may run live compute. */
  canLive: boolean
  /** The mode feature pages actually use right now. */
  mode: AccessMode
  /** What a pro user picked with the Live/Demo toggle. */
  preferredMode: AccessMode
  setPreferredMode: (m: AccessMode) => void
  /** Call when the API answers 403 pro_required: falls back to demo and refreshes the account. */
  reportProRequired: () => void
}

/** Inert default so components render (in demo mode) outside a provider, e.g. in isolated tests. */
export const DEFAULT_ACCESS: AccessState = {
  status: 'anonymous',
  user: null,
  plan: 'anonymous',
  isAdmin: false,
  canLive: false,
  mode: 'demo',
  preferredMode: 'live',
  setPreferredMode: () => undefined,
  reportProRequired: () => undefined,
}

export const AccessContext = createContext<AccessState>(DEFAULT_ACCESS)

export function useAccess(): AccessState {
  return useContext(AccessContext)
}

export const MODE_STORAGE_KEY = 'tel_mode'

/** Pure plan derivation, exported for tests. A pro plan past its expiry counts as free. */
export function derivePlan(user: UserResponse | null, now: number = Date.now()): { plan: AccessPlan; canLive: boolean } {
  if (!user) return { plan: 'anonymous', canLive: false }
  if (user.is_admin) return { plan: 'admin', canLive: true }
  if (user.plan === 'pro') {
    const exp = user.plan_expires_at ? Date.parse(user.plan_expires_at) : NaN
    if (Number.isFinite(exp) && exp <= now) return { plan: 'free', canLive: false }
    return { plan: 'pro', canLive: true }
  }
  return { plan: 'free', canLive: false }
}
