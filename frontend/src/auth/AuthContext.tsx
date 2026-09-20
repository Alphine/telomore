import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError, getToken, setToken as persistToken } from '../api/client'
import { login as apiLogin, me as apiMe } from '../api/endpoints'
import type { UserResponse } from '../api/types'
import { AuthContext } from './context'
import type { AuthState, AuthStatus, LoginOutcome } from './context'
import { clearPersistentState } from '../state/usePersistentState'

interface AuthProviderProps {
  children: ReactNode
  /** Test hook: start from an explicit token instead of localStorage. */
  initialToken?: string | null
}

// The JWT is persisted in localStorage (key `tel_token`) so a login survives
// a page reload -- a deliberate UX improvement over the Streamlit app's
// session-only login. Trade-off: a token in localStorage is readable by any
// script running on this origin (XSS), unlike an HttpOnly cookie; acceptable
// for this research prototype, revisit if the threat model changes.
export function AuthProvider({ children, initialToken }: AuthProviderProps) {
  const [token, setTokenState] = useState<string | null>(() =>
    initialToken === undefined ? getToken() : initialToken,
  )
  const [user, setUser] = useState<UserResponse | null>(null)
  const [status, setStatus] = useState<AuthStatus>(() => (token ? 'loading' : 'anonymous'))

  const clear = useCallback(() => {
    clearPersistentState() // one user's results must not show for the next
    persistToken(null)
    setTokenState(null)
    setUser(null)
    setStatus('anonymous')
  }, [])

  // Hydrate on start (and after login): a token is only trusted once
  // /auth/me accepts it. `status` is set to 'loading' by whoever sets the
  // token (initial state / login), so no synchronous setState here.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    apiMe(token)
      .then((u) => {
        if (cancelled) return
        setUser(u)
        setStatus('authenticated')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          clear()
        } else {
          // Network/server hiccup: keep the token, but do not claim to be
          // logged in -- the guard will send the user to /login.
          setStatus('anonymous')
        }
      })
    return () => {
      cancelled = true
    }
  }, [token, clear])

  const login = useCallback(async (username: string, password: string): Promise<LoginOutcome> => {
    try {
      const res = await apiLogin({ username, password })
      persistToken(res.access_token)
      setStatus('loading')
      setTokenState(res.access_token) // triggers the hydration effect -> /auth/me
      return { ok: true }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 401) return { ok: false, reason: 'wrong_credentials', message: err.message }
        if (err.status === 403) return { ok: false, reason: 'not_verified', message: err.message }
        return { ok: false, reason: 'error', message: err.message }
      }
      return { ok: false, reason: 'error', message: 'Could not reach the API.' }
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ token, user, status, login, logout: clear }),
    [token, user, status, login, clear],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
