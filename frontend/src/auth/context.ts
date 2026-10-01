import { createContext, useContext } from 'react'

import type { UserResponse } from '../api/types'

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated'

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: 'wrong_credentials' | 'not_verified' | 'error'; message: string }

export interface AuthState {
  token: string | null
  user: UserResponse | null
  status: AuthStatus
  login: (username: string, password: string) => Promise<LoginOutcome>
  logout: () => void
  /** Re-read /auth/me (after an access request or an admin plan change). */
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
